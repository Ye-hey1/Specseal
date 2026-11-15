//! Specseal 桌面 app 的 Tauri 壳。
//!
//! 每个 #[tauri::command] 是对 specseal-desktop-core 的单行委派（薄包装）——
//! 真正的逻辑与测试在 specseal-desktop-core，此层只做 IPC 接线。
//! Rust 侧无 current-root 可变全域（workspace-session 决策 4）：所有读写
//! command 逐调用收 root，直通 desktop-core 的带路径函数；分页切换不再改写
//! 任何全域，前一分页 in-flight 调用以其原 root 结算。
//!
//! # 线程契约
//!
//! 非 async command 在 app 唯一的主线程上运行——期间窗口事件、tray 图标
//! 点击、面板开闭全部停摆。因此凡会触及文件系统或 spawn 子进程（git 等）的
//! command，一律 async fn＋`tauri::async_runtime::spawn_blocking` 委派至线程
//! 池（design D2 原只涵盖写入侧，desktop-async-commands 扩及全部 IO command）。
//!
//! 维持同步的只有纯内存或纯窗口操作，不触文件系统、不 spawn 子进程：
//!
//! - `startup_dir`——读行程环境（启动时的工作目录）
//! - `app_info`——读编译期版本常数与平台（关于页）
//! - `connection_state`——读内存中的 TokenManager 健康状态
//! - `remote_unwatch`——退订事件中枢，只动内存中的订阅表
//! - `toggle_tray_panel`、`hide_tray_panel`、`quit_app`——纯窗口／行程操作
//!   （例外：Windows 的 `toggle_tray_panel` 为 async——在同步 command 内置立窗口，
//!   Windows 会因 WebView2 死结，见 Tauri `WebviewWindowBuilder::new` 的 Known issues）
//! - tray recovery 动作转发（[`tray`] 模块）——只钉 action 名称与聚焦政策
//!
//! 添加 command 时：只要碰到文件系统或子进程，就是 async＋spawn_blocking。

pub mod cli_install;
pub mod connections;
pub mod event_manager;
mod fs_actions;
pub mod remote;
pub mod tray;
mod watch;
mod panel;
#[cfg(target_os = "macos")]
mod trackpad_gesture;

use std::path::PathBuf;

use serde_json::Value;
use tauri::{Emitter, Manager};

/// 关于页的版本信息（desktop-about-page design D1）：app 版号由壳带入，其余由 desktop-core 回齐。
#[tauri::command]
fn app_info(app: tauri::AppHandle) -> specseal_desktop_core::project::AppInfo {
    specseal_desktop_core::project::app_info(&app.package_info().version.to_string())
}

#[tauri::command]
async fn cli_install_probe(app: tauri::AppHandle) -> Result<cli_install::CliInstallProbe, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || cli_install::probe(version))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cli_deploy(plan: cli_install::CliDeployPlan) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cli_install::deploy(plan))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn cli_zprofile_append(line: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cli_install::zprofile_append(&line))
        .await
        .map_err(|e| e.to_string())?
}

// 读取型 command 一律回 Result：worker 失败（JoinError——闭包 panic 或
// 关闭期取消）转为 invoke 错误回报。留 .expect 会在 tokio task 内 panic 被
// 吞掉，前端 promise 永不 settle；成功路径的回传形状不变。
#[tauri::command]
async fn list_changes(root: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::list_changes_at(&root)
    })
    .await
    .map_err(|e| format!("list_changes worker failed: {e}"))
}

#[tauri::command]
async fn list_specs(root: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || specseal_desktop_core::query::list_specs_at(&root))
        .await
        .map_err(|e| format!("list_specs worker failed: {e}"))
}

#[tauri::command]
async fn status(root: PathBuf, change: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::status_at(&root, &change)
    })
    .await
    .map_err(|e| format!("status worker failed: {e}"))?
}

#[tauri::command]
async fn document(root: PathBuf, change: String, artifact: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::document_at(&root, &change, &artifact)
    })
    .await
    .map_err(|e| format!("document worker failed: {e}"))
}

#[tauri::command]
async fn spec_document(root: PathBuf, capability: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::spec_document_at(&root, &capability)
    })
    .await
    .map_err(|e| format!("spec_document worker failed: {e}"))
}

#[tauri::command]
async fn list_manual_pages(root: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manual::list_manual_pages_at(&root)
    })
    .await
    .map_err(|e| format!("list_manual_pages worker failed: {e}"))
}

#[tauri::command]
async fn get_manual_page(root: PathBuf, slug: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manual::manual_page_at(&root, &slug)
    })
    .await
    .map_err(|e| format!("get_manual_page worker failed: {e}"))
}

#[tauri::command]
async fn search_workspace(root: PathBuf, query: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::search::search_workspace_at(&root, &query)
    })
    .await
    .map_err(|e| format!("search_workspace worker failed: {e}"))
}

#[tauri::command]
async fn change_capabilities(root: PathBuf, change: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::change_capabilities_at(&root, &change)
    })
    .await
    .map_err(|e| format!("change_capabilities worker failed: {e}"))
}

#[tauri::command]
async fn change_meta(root: PathBuf, change: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::change_meta_at(&root, &change)
    })
    .await
    .map_err(|e| format!("change_meta worker failed: {e}"))
}

#[tauri::command]
async fn delete_change(root: PathBuf, change: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::delete_change_at(&root, &change)
    })
    .await
    .map_err(|e| format!("delete_change worker failed: {e}"))?
}

#[tauri::command]
async fn revert_change_to_proposed(root: PathBuf, change: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::revert_change_to_proposed_at(&root, &change)
    })
    .await
    .map_err(|e| format!("revert worker failed: {e}"))?
}

#[tauri::command]
// 写入型 command 一律 async＋spawn_blocking（design D2）：完成路径可能秒级
// （git spawn 在部分环境极慢），非 async command 会占用主线程冻结整窗。
// 委派移至线程池；并发写回由 desktop-core 的全域写锁串行化。
async fn set_task_done(
    root: PathBuf,
    change: String,
    task: String,
    done: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::set_task_done_at(&root, &change, &task, done)
    })
    .await
    .map_err(|e| format!("task write worker failed: {e}"))?
}

#[tauri::command]
async fn set_all_tasks(root: PathBuf, change: String, done: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::set_all_tasks_at(&root, &change, done)
    })
    .await
    .map_err(|e| format!("task write worker failed: {e}"))?
}

#[tauri::command]
async fn move_task(
    root: PathBuf,
    change: String,
    from: usize,
    to: usize,
    before: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::move_task_at(&root, &change, from, to, before)
    })
    .await
    .map_err(|e| format!("task write worker failed: {e}"))?
}

#[tauri::command]
async fn reorder_card(
    root: PathBuf,
    kind: String,
    id: String,
    prev_id: Option<String>,
    next_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::reorder_card_at(
            &root,
            &kind,
            &id,
            prev_id.as_deref(),
            next_id.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("task write worker failed: {e}"))?
}

#[tauri::command]
// 前置的添加与移除（add-change-plan-desktop design D6）：单行委派到桌面 core，
// 守门与错误文本都是引擎的。
async fn set_change_depends(
    root: PathBuf,
    change: String,
    on: Vec<String>,
    remove: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::set_depends_at(&root, &change, &on, remove)
    })
    .await
    .map_err(|e| format!("task write worker failed: {e}"))?
}

#[tauri::command]
// 调度分页的前置候选名册（add-change-plan-remote D9）：单行委派到桌面 core，与
// set_change_depends 同一定根。
async fn depends_candidates(root: PathBuf, change: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manage::depends_candidates_at(&root, &change)
    })
    .await
    .map_err(|e| format!("depends candidates worker failed: {e}"))?
}

#[tauri::command]
async fn validate(root: PathBuf, change: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::verbs::validate_at(&root, &change)
    })
    .await
    .map_err(|e| format!("validate worker failed: {e}"))?
}

#[tauri::command]
async fn analyze(root: PathBuf, change: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::verbs::analyze_at(&root, &change)
    })
    .await
    .map_err(|e| format!("analyze worker failed: {e}"))?
}

#[tauri::command]
async fn archive(root: PathBuf, change: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::verbs::archive_at(&root, &change)
    })
    .await
    .map_err(|e| format!("archive worker failed: {e}"))?
}

#[tauri::command]
async fn archive_carry(
    root: PathBuf,
    change: String,
    carry_review: bool,
    carry_verify: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::verbs::archive_carry_at(&root, &change, carry_review, carry_verify)
    })
    .await
    .map_err(|e| format!("archive_carry worker failed: {e}"))?
}

#[tauri::command]
async fn discard_review(root: PathBuf, change: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::verbs::discard_review_at(&root, &change)
    })
    .await
    .map_err(|e| format!("discard_review worker failed: {e}"))?
}

#[tauri::command]
async fn discard_verify(root: PathBuf, change: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::verbs::discard_verify_at(&root, &change)
    })
    .await
    .map_err(|e| format!("discard_verify worker failed: {e}"))?
}

#[tauri::command]
async fn archived_changes(root: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::cache::archived_changes_at(&root)
    })
    .await
    .map_err(|e| format!("archived_changes worker failed: {e}"))
}

#[tauri::command]
async fn archived_document(
    root: PathBuf,
    dated_name: String,
    artifact: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::archived_document_at(&root, &dated_name, &artifact)
    })
    .await
    .map_err(|e| format!("archived_document worker failed: {e}"))
}

#[tauri::command]
async fn archived_capabilities(root: PathBuf, dated_name: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::archived_capabilities_at(&root, &dated_name)
    })
    .await
    .map_err(|e| format!("archived_capabilities worker failed: {e}"))
}

/// 一站的活工单（drawer-quality-ticket-tab D1／D2）：`{ "rounds": [ … ] }`，无工单、
/// 未知站别或格式坏掉皆回 null。
#[tauri::command]
async fn station_ticket(root: PathBuf, change: String, station: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::station_ticket_at(&root, &change, &station)
    })
    .await
    .map_err(|e| format!("station_ticket worker failed: {e}"))
}

/// 已封存 change 带走的工单，形状与 null 语意同 `station_ticket`。
#[tauri::command]
async fn archived_station_ticket(
    root: PathBuf,
    dated_name: String,
    station: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::archived_station_ticket_at(&root, &dated_name, &station)
    })
    .await
    .map_err(|e| format!("archived_station_ticket worker failed: {e}"))
}

/// change artifact 的磁盘位置（详情页「打开 ▾」）：与 `document` 同一套解析（worktree 副本）。
#[tauri::command]
async fn document_location(
    root: PathBuf,
    change: String,
    artifact: String,
) -> Result<Option<specseal_desktop_core::query::DocumentLocation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::document_location_at(&root, &change, &artifact)
    })
    .await
    .map_err(|e| format!("document_location worker failed: {e}"))
}

/// 讨论记录的磁盘位置（详情页「打开 ▾」）：与 `discussion_document` 同一套解析（封存后备）。
#[tauri::command]
async fn discussion_location(
    root: PathBuf,
    slug: String,
) -> Result<Option<specseal_desktop_core::query::DocumentLocation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::discussions::discussion_location_at(&root, &slug)
    })
    .await
    .map_err(|e| format!("discussion_location worker failed: {e}"))
}

/// 正式规格的磁盘位置（规格详情页「打开 ▾」）：与 `spec_document` 同一个 store。
#[tauri::command]
async fn spec_location(
    root: PathBuf,
    capability: String,
) -> Result<Option<specseal_desktop_core::query::DocumentLocation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::spec_location_at(&root, &capability)
    })
    .await
    .map_err(|e| format!("spec_location worker failed: {e}"))
}

/// 手册页的磁盘位置（手册页「打开 ▾」）：与 `get_manual_page` 同一条 slug 守门与路径解析。
#[tauri::command]
async fn manual_location(
    root: PathBuf,
    slug: String,
) -> Result<Option<specseal_desktop_core::query::DocumentLocation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::manual::manual_location_at(&root, &slug)
    })
    .await
    .map_err(|e| format!("manual_location worker failed: {e}"))
}

/// 已封存 change 的 artifact 磁盘位置（已封存详情页「打开 ▾」）：与 `archived_document` 同一个 store。
#[tauri::command]
async fn archived_document_location(
    root: PathBuf,
    dated_name: String,
    artifact: String,
) -> Result<Option<specseal_desktop_core::query::DocumentLocation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::query::archived_document_location_at(&root, &dated_name, &artifact)
    })
    .await
    .map_err(|e| format!("archived_document_location worker failed: {e}"))
}

#[tauri::command]
async fn list_discussions(root: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::discussions::list_discussions_at(&root)
    })
    .await
    .map_err(|e| format!("list_discussions worker failed: {e}"))
}

#[tauri::command]
async fn discussion_document(
    root: PathBuf,
    slug: String,
) -> Result<Option<specseal_desktop_core::discussions::DiscussionDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::discussions::discussion_document_at(&root, &slug)
    })
    .await
    .map_err(|e| format!("discussion_document worker failed: {e}"))
}

#[tauri::command]
async fn promote_discussion(
    root: PathBuf,
    slug: String,
    name: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::discussions::promote_discussion_at(&root, &slug, name.as_deref())
    })
    .await
    .map_err(|e| format!("promote_discussion worker failed: {e}"))?
}

#[tauri::command]
async fn archive_discussion(root: PathBuf, slug: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::discussions::archive_discussion_at(&root, &slug)
    })
    .await
    .map_err(|e| format!("archive_discussion worker failed: {e}"))?
}

/// 监看器槽位：目标集合不变时沿用原监看，改变时整颗替换（drop 旧监看即停止）。
/// `tickets` 于 command 进 pool 前取号——两条重挂链（activation 与
/// workspace-changed 驱动）交错时，槽位以序号拒绝陈旧的慢工反超。
struct WatcherState {
    tickets: std::sync::atomic::AtomicU64,
    slot: std::sync::Mutex<watch::WatchSlot>,
}

impl WatcherState {
    /// 取号是纯内存操作，于 command 进 pool 前调用。
    fn next_ticket(&self) -> u64 {
        self.tickets.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, watch::WatchSlot> {
        self.slot.lock().expect("watcher lock poisoned")
    }

    /// 暂停监看期间运行 `f`（desktop-spec-dir-migration D2）；`f` 结束（含 panic）即恢复。
    fn while_paused<T>(&self, ticket: u64, f: impl FnOnce() -> T) -> T {
        struct Resume<'a>(&'a WatcherState);
        impl Drop for Resume<'_> {
            fn drop(&mut self) {
                if let Ok(mut slot) = self.0.slot.lock() {
                    slot.resume();
                }
            }
        }
        self.slot().pause(ticket);
        let _resume = Resume(self);
        f()
    }
}

/// git 身分预热（design D1）：首抓可能秒级（GUI 进程 spawn git 极慢的环境），
/// 挂监看（＝项目成为活跃）时背景线程先填缓存——首次勾选不再付这笔成本。
/// 失败静默，完成路径的 cached_git_identity 会自行补抓。
fn prewarm_identity(root: PathBuf) {
    std::thread::spawn(move || {
        let _ = specseal_desktop_core::manage::cached_git_identity(&root);
    });
}

/// 打开项目＝纯探测：只回报本机 project／remoteBinding／uninitialized payload，
/// 错误走 Result；不改写任何全域、不重挂
/// 监看——同一路径重复调用幂等无副作用。监看跟随由前端显式 watch_workspace。
#[tauri::command]
async fn open_project(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let probe = specseal_desktop_core::project::open_project_at(std::path::Path::new(&path))?;
        serde_json::to_value(&probe).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("open_project worker failed: {e}"))?
}

#[tauri::command]
async fn init_project(path: String, tools: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let probe =
            specseal_desktop_core::project::init_project_at(std::path::Path::new(&path), &tools)?;
        serde_json::to_value(&probe).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("init_project worker failed: {e}"))?
}

/// 对未激活文件夹补齐工作区档（desktop-enable-specseal-prompt 决策 4：独立
/// command，不复用 init_project——其引擎路径对已有 openspec/ 的目录必然 bail）。
#[tauri::command]
async fn adopt_project(path: String, tools: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let probe =
            specseal_desktop_core::project::adopt_project_at(std::path::Path::new(&path), &tools)?;
        serde_json::to_value(&probe).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("adopt_project worker failed: {e}"))?
}

/// 启动语境的缺省目录（决策 4 首启路径）：回传行程启动时的工作目录——前端
/// 首启无持久化分页时据此显式 openProjectAt（自项目目录启动的自动打开语意
/// 冻结）。纯读、无任何可变全域。
#[tauri::command]
fn startup_dir() -> String {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .display()
        .to_string()
}

/// 项目统计（背景分页徽章快照）：唯读、收路径参数。
#[tauri::command]
async fn project_stats(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::project::project_stats_at(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| format!("project_stats worker failed: {e}"))?
}

/// 技能档过期探测（desktop-instruction-staleness-prompt 决策 4）：独立唯读
/// command，不挂进 open_project——后者是纯探测 probe，不承担第二职责。
#[tauri::command]
async fn probe_assets(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::project::probe_assets_at(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| format!("probe_assets worker failed: {e}"))
}

/// 技能档整套再生（决策 5）：委派引擎既有 update()。写入型 command 一律
/// async＋spawn_blocking（design D2）——再生十余个文件，不得冻结主线程。
/// update 可能把 openspec/ 改名为 specseal/：整段更新期间暂停监看（Windows 上活着的
/// 监看会挡住改名），前端完成后以 watch_workspace 重挂（desktop-spec-dir-migration D2）。
#[tauri::command]
async fn update_assets(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    let ticket = app.try_state::<WatcherState>().map(|state| state.next_ticket());
    tauri::async_runtime::spawn_blocking(move || {
        let update = || specseal_desktop_core::project::update_assets_at(std::path::Path::new(&path));
        match (app.try_state::<WatcherState>(), ticket) {
            (Some(state), Some(ticket)) => state.while_paused(ticket, update),
            _ => update(),
        }
    })
    .await
    .map_err(|e| format!("asset update worker failed: {e}"))?
}

/// 监看重挂（决策 5）：显式跟随活跃 session。前端于每次 workspace-changed
/// 后也会重挂（worktree 增减会改变监看拓扑）——槽位比对目标集合，不变即
/// 沿用原监看，真的重建时才预热 git 身分。workspace-changed 事件 payload 为
/// 被监看的 root 字符串（session 的事件来源据此过滤）。root 收字符串并原样回送，
/// 避免 PathBuf 往返改写字面。
/// 监看不可用仅记录、不回错——app 照常、仅失去自动刷新（既有降级语意）。
/// 挂载大树（递归走访）属 IO，整段重挂移至 spawn_blocking——槽位锁在背景
/// 线程取得，主线程不等待挂载完成。序号在进 pool 前取（取号是纯内存
/// 操作）：pool 内完成顺序不定，槽位据此拒绝陈旧的慢工反超。
#[tauri::command]
async fn watch_workspace(app: tauri::AppHandle, root: String) {
    let ticket = match app.try_state::<WatcherState>() {
        Some(state) => state.next_ticket(),
        None => return,
    };
    let root_path = PathBuf::from(&root);
    let emitter = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<WatcherState>() else {
            return;
        };
        let rearmed = state.slot().rearm(
            ticket,
            &root_path,
            std::time::Duration::from_millis(400),
            move || {
                let _ = emitter.emit("workspace-changed", root.clone());
            },
        );
        match rearmed {
            Ok(true) => prewarm_identity(root_path),
            Ok(false) => {}
            Err(e) => eprintln!("specseal-desktop: file watching unavailable: {e}"),
        }
    })
    .await;
    if let Err(e) = joined {
        eprintln!("specseal-desktop: watch worker failed: {e}");
    }
}

/// 有 checkout 的 remote 项目的技能档监看（remote-skill-delivery D8）：挂上 checkout 里
/// 各工具的技能目录与 `.specseal.yaml`，变动时以 `checkout-skills-changed` 通知（payload 为
/// checkout 的路径，原样回送）。和本机的 `workspace-changed` 分开：它只让前端重新探测
/// 技能档，不重新加载项目数据。沿用同一个监看槽位——跟著作用中的分页，同一时间只有一个
/// 监看。挂不上只记录、不回错（既有降级语意）。
#[tauri::command]
async fn watch_checkout_skills(app: tauri::AppHandle, checkout: String) {
    let ticket = match app.try_state::<WatcherState>() {
        Some(state) => state.next_ticket(),
        None => return,
    };
    let checkout_path = PathBuf::from(&checkout);
    let emitter = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<WatcherState>() else {
            return;
        };
        let rearmed = state.slot().rearm_checkout(
            ticket,
            &checkout_path,
            std::time::Duration::from_millis(400),
            move || {
                let _ = emitter.emit("checkout-skills-changed", checkout.clone());
            },
        );
        if let Err(e) = rearmed {
            eprintln!("specseal-desktop: checkout skill watching unavailable: {e}");
        }
    })
    .await;
    if let Err(e) = joined {
        eprintln!("specseal-desktop: watch worker failed: {e}");
    }
}

#[tauri::command]
async fn read_settings(root: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = specseal_desktop_core::settings::read_settings_at(&root)?;
        serde_json::to_value(&snapshot).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("read_settings worker failed: {e}"))?
}

#[tauri::command]
async fn write_app_tools(root: PathBuf, tools: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::settings::write_tools_at(&root, &tools)
    })
    .await
    .map_err(|e| format!("write_app_tools worker failed: {e}"))?
}

#[tauri::command]
async fn write_workflow_config(
    root: PathBuf,
    locale: Option<String>,
    spec_locale: Option<String>,
    tdd: bool,
    audit: bool,
    worktree: bool,
) -> Result<(), String> {
    let fields = specseal_desktop_core::settings::WorkflowPolicyFields {
        locale,
        spec_locale,
        tdd,
        audit,
        worktree,
    };
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::settings::write_workflow_fields_at(&root, &fields)
    })
    .await
    .map_err(|e| format!("write_workflow_config worker failed: {e}"))?
}

/// 产出流程快照（desktop-schema-panel design D2）：root 有值＝local 三层组装；
/// 缺席＝remote 模式，desktop core 以内嵌内置组装（不打 server、不读本机层）。
#[tauri::command]
async fn read_schemas(root: Option<PathBuf>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = match root {
            Some(root) => specseal_desktop_core::settings::read_schemas_at(&root)?,
            None => specseal_desktop_core::settings::builtin_schemas(),
        };
        serde_json::to_value(&snapshot).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("read_schemas worker failed: {e}"))?
}

#[tauri::command]
async fn write_workflow_schema(root: PathBuf, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::settings::write_workflow_schema_at(&root, &name)
    })
    .await
    .map_err(|e| format!("write_workflow_schema worker failed: {e}"))?
}

#[tauri::command]
async fn fork_schema(root: PathBuf, source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::settings::fork_schema_at(&root, &source)
    })
    .await
    .map_err(|e| format!("fork_schema worker failed: {e}"))?
}

/// 创建自订 schema 骨架（design D5）：布局用引擎缺省，名称验证在引擎。
#[tauri::command]
async fn init_schema(root: PathBuf, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::settings::init_schema_at(&root, &name)
    })
    .await
    .map_err(|e| format!("init_schema worker failed: {e}"))?
}

/// 删除项目层自订 schema（design D7）：使用中拒删、目标由 core 固定解析。
#[tauri::command]
async fn delete_schema(root: PathBuf, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::settings::delete_schema_at(&root, &name)
    })
    .await
    .map_err(|e| format!("delete_schema worker failed: {e}"))?
}

/// 在系统文件管理器显示路径（design D6 编辑入口）：path 来自 read_schemas 快照。
#[tauri::command]
async fn reveal_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// 以系统缺省 App 打开详情页目前分页的文档（design D4「打开 ▾」）：与
/// `reveal_in_folder` 同一条 opener 路径；只收实际目标为 `.md` 的文件，其余拒绝
/// （见 `check_default_open`）。
#[tauri::command]
async fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    specseal_desktop_core::fs_actions::check_default_open(&path)?;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 写入 config.yaml 的「项目说明」「产出规则」「审查规则」与「子代理模型」。
/// `context: None`＝不动、`Some(文本)`＝设值（空白即移除键，core 落实）；
/// `rules: None`＝不动、`Some(节序清单)`＝整份代换；`review`、`subagent_model`
/// 同理（`Some` 整块代换）。政策字段不受本 command 波及。
#[tauri::command]
async fn write_workflow_content(
    root: PathBuf,
    context: Option<String>,
    rules: Option<Vec<(String, Vec<String>)>>,
    review: Option<specseal_desktop_core::settings::ReviewConfig>,
    subagent_model: Option<specseal_desktop_core::settings::SubagentModelConfig>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        specseal_desktop_core::settings::write_workflow_content_at(
            &root,
            &content_edit(context, &rules, &review, &subagent_model),
        )
    })
    .await
    .map_err(|e| format!("write_workflow_content worker failed: {e}"))?
}

/// 两个内容写入指令共用的参数转换：context 为 null 不动、有值即设值（空白＝移除，
/// core 落实）；rules、review 与 subagent_model 为 null 不动。
fn content_edit<'a>(
    context: Option<String>,
    rules: &'a Option<Vec<(String, Vec<String>)>>,
    review: &'a Option<specseal_desktop_core::settings::ReviewConfig>,
    subagent_model: &'a Option<specseal_desktop_core::settings::SubagentModelConfig>,
) -> specseal_desktop_core::settings::ContentEdit<'a> {
    use specseal_desktop_core::settings::{ContentEdit, ContextEdit};
    ContentEdit {
        context: context.map_or(ContextEdit::Keep, ContextEdit::Set),
        rules: rules.as_deref(),
        review: review.as_ref(),
        subagent_model: subagent_model.as_ref(),
    }
}

/// 连接 registry 档位置：appConfigDir 下 connections.json（design 决策 4）。
fn connections_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| connections::registry_path(&dir))
        .map_err(|e| format!("无法取得 app 设置目录：{e}"))
}

/// 连接层状态：credential 出入口（生产＝OS Keychain）与 per-origin 的
/// TokenManager（access token 内存持有——短效、绝不落盘、绝不过境 TS，
/// 决策 2；换发与 401 语意见 remote 模块）。
struct ConnectionsState {
    credentials: Box<dyn specseal_remote::credentials::CredentialStore>,
    managers:
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<remote::TokenManager>>>,
    state_observer: std::sync::Arc<dyn Fn(remote::ConnectionStateEvent) + Send + Sync>,
    /// 进行中的登录的取消旗标（connection_login_cancel 设置）。
    logins: connections::LoginCancels,
}

impl ConnectionsState {
    /// 该 origin 的 TokenManager——惰性创建、跨 command 共用（needs-reauth
    /// 状态与 token 缓存都挂在同一颗上）。
    fn manager_for(&self, origin: &str) -> std::sync::Arc<remote::TokenManager> {
        let observer = self.state_observer.clone();
        self.managers
            .lock()
            .expect("manager lock")
            .entry(origin.to_string())
            .or_insert_with(|| {
                std::sync::Arc::new(remote::TokenManager::with_state_observer(
                    origin,
                    remote::DEFAULT_FAILURE_THRESHOLD,
                    move |event| observer(event),
                ))
            })
            .clone()
    }

    fn manager_for_connection(
        &self,
        connection_id: &str,
        origin: &str,
    ) -> std::sync::Arc<remote::TokenManager> {
        let manager = self.manager_for(origin);
        manager.bind_connection_id(connection_id);
        manager
    }
}

/// 条目的 TS 查看：registry 字段＋由 Keychain 推导的登录状态。secret 不出现。
fn entry_view(entry: &connections::ConnectionEntry, state: &ConnectionsState) -> Value {
    let logged_in = connections::logged_in(&entry.origin, &*state.credentials);
    let mut view = serde_json::to_value(entry).expect("entry serializes");
    view["loggedIn"] = Value::Bool(logged_in);
    view
}

#[tauri::command]
async fn connection_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let path = connections_path(&app)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(connections::read_registry(&path)
            .iter()
            .map(|entry| entry_view(entry, &state))
            .collect())
    })
    .await
    .map_err(|e| format!("connection_list worker failed: {e}"))?
}

#[tauri::command]
async fn connection_add(
    app: tauri::AppHandle,
    base_url: String,
    name: String,
) -> Result<Value, String> {
    let path = connections_path(&app)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = connections::add_connection(&path, &base_url, &name)?;
        Ok(entry_view(&entry, &state))
    })
    .await
    .map_err(|e| format!("connection_add worker failed: {e}"))?
}

/// chooser 的 checkout 先检查阶段（零写入）：验证文件夹与 marker 一致性，
/// 回传 `{ root, tools }` 供 picker 显示既有 built-in 工具选集。
#[tauri::command]
async fn inspect_checkout(
    path: String,
    origin: String,
    project: String,
    repo: String,
) -> Result<connections::CheckoutInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        connections::inspect_checkout(std::path::Path::new(&path), &origin, &project, &repo)
    })
    .await
    .map_err(|e| format!("inspect_checkout worker failed: {e}"))?
}

/// chooser 的 checkout 提交阶段：重做 marker 边界验证，无 marker 时写入与 CLI
/// init remote 同构的 remote section，再对非空 built-in 选集运行 Core reconciliation。
#[tauri::command]
async fn bind_checkout(
    path: String,
    origin: String,
    project: String,
    repo: String,
    tools: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        connections::bind_checkout(std::path::Path::new(&path), &origin, &project, &repo, &tools)
    })
    .await
    .map_err(|e| format!("bind_checkout worker failed: {e}"))?
}

/// 移除连接（决策 6）：注销与删条目的交易语意在 connections::remove_connection
/// （锁内运行）；此处只补 in-memory TokenManager 的清理。
#[tauri::command]
async fn connection_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = connections_path(&app)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 条目要消失了：先取消等待中的登录，它才不会在注销之后写回 credential。
        if let Some(entry) = connections::read_registry(&path).iter().find(|e| e.id == id) {
            state.logins.cancel(&entry.origin);
        }
        if let Some(origin) = connections::remove_connection(&path, &id, &*state.credentials)? {
            state.managers.lock().expect("manager lock").remove(&origin);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("connection_remove worker failed: {e}"))?
}

/// 登录（client-browser-login D7）：在 blocking pool 跑共用的登录程序直到终态；
/// 途中的等待阶段经 `connection-login-phase` 事件送往前端，浏览器打开走
/// tauri-plugin-opener，取消由 connection_login_cancel 设旗标。回 TS 的只有状态
/// 与显示名——access token 交给内存持有、refresh credential 已写入 Keychain。
#[tauri::command]
async fn connection_login_start(app: tauri::AppHandle, origin: String) -> Result<Value, String> {
    let path = connections_path(&app)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    let cancel = state.logins.begin(&origin);
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = app.clone();
        let emit = move |event: connections::LoginPhaseEvent| {
            let _ = emitter.emit(connections::LOGIN_PHASE_EVENT, event);
        };
        let opener = move |url: &str| -> Result<(), String> {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(url.to_string(), None::<String>)
                .map_err(|e| format!("无法打开系统浏览器：{e}"))
        };
        let io = connections::DesktopLoginIo {
            origin: &origin,
            emit: &emit,
            open_browser: &opener,
            cancel: &cancel,
        };
        let outcome = connections::connection_login(&origin, &*state.credentials, &path, &io);
        state.logins.end(&origin, &cancel);
        let outcome = outcome?;
        if let connections::ConnectionLogin::LoggedIn { access_token: Some(access_token), .. } = &outcome {
            state.manager_for(&origin).adopt_access_token(access_token);
        }
        Ok(outcome.view())
    })
    .await
    .map_err(|e| format!("login worker failed: {e}"))?
}

/// 取消等待中的登录：设旗标，等待循环在下一个切片结束并回 cancelled。
#[tauri::command]
fn connection_login_cancel(app: tauri::AppHandle, origin: String) {
    app.state::<std::sync::Arc<ConnectionsState>>().logins.cancel(&origin);
}

/// PAT 登录：PAT 仅单次过境此参数（不回读、不入 log、不进 TS 状态）。
#[tauri::command]
async fn pat_login(app: tauri::AppHandle, origin: String, pat: String) -> Result<Value, String> {
    let path = connections_path(&app)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let display = connections::pat_login(&origin, &pat, &*state.credentials, &path)?;
        state.manager_for(&origin).adopt_access_token(&pat);
        Ok(serde_json::json!({ "status": "loggedIn", "display": display }))
    })
    .await
    .map_err(|e| format!("login worker failed: {e}"))?
}

/// 连接的 runtime 状态（remote 决策 4）：needs-reauth 布尔＋繁中消息。TS 据此
/// 呈现需重新认证，token 本身永不出现。
#[tauri::command]
fn connection_state(app: tauri::AppHandle, origin: String) -> Value {
    let state = app.state::<std::sync::Arc<ConnectionsState>>();
    let message = state.manager_for(&origin).needs_reauth();
    serde_json::json!({ "needsReauth": message.is_some(), "message": message })
}

/// 注销（决策 6）：尽力撤销＋必删本机，并丢弃内存中的 access token。
#[tauri::command]
async fn connection_logout(app: tauri::AppHandle, origin: String) -> Result<Value, String> {
    let path = connections_path(&app)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = connections::logout(&origin, &*state.credentials, &path)?;
        state.managers.lock().expect("manager lock").remove(&origin);
        Ok(serde_json::json!({
            "revokedOnServer": outcome.revoked_on_server,
            "patNotice": outcome.pat_notice,
        }))
    })
    .await
    .map_err(|e| format!("logout worker failed: {e}"))?
}

// --- remote workspace 数据面（remote-data-source 决策 6、7） ---

/// connectionId → origin（registry 查找）。条目消失＝连接已被移除。
fn connection_origin(app: &tauri::AppHandle, connection_id: &str) -> Result<String, String> {
    let path = connections_path(app)?;
    connections::read_registry(&path)
        .iter()
        .find(|entry| entry.id == connection_id)
        .map(|entry| entry.origin.clone())
        .ok_or_else(|| "连接不存在——请重新设置 server 连接".to_string())
}

/// 数据面命令的共用骨架：解析 origin、取 TokenManager，于 blocking pool 以
/// 无状态重建的 RemoteWorkspace 运行一击。
async fn with_remote<T, F>(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    call: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&remote::RemoteWorkspace, &dyn specseal_remote::credentials::CredentialStore) -> Result<T, String>
        + Send
        + 'static,
{
    let origin = connection_origin(&app, &connection_id)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = state.manager_for_connection(&connection_id, &origin);
        let workspace = remote::RemoteWorkspace::at(&origin, &project, &repo, &manager);
        call(&workspace, &*state.credentials)
    })
    .await
    .map_err(|e| format!("remote worker failed: {e}"))?
}

/// remote settings 专用骨架：错误保留 reason/status 的结构化形状，供前端
/// 辨识 revision_conflict；其他数据面仍沿用既有单行 String 契约。
async fn with_remote_settings<T, F>(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    call: F,
) -> Result<T, remote::RemoteSettingsError>
where
    T: Send + 'static,
    F: FnOnce(
            &remote::RemoteWorkspace,
            &dyn specseal_remote::credentials::CredentialStore,
        ) -> Result<T, remote::RemoteSettingsError>
        + Send
        + 'static,
{
    let origin =
        connection_origin(&app, &connection_id).map_err(remote::RemoteSettingsError::command)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = state.manager_for_connection(&connection_id, &origin);
        let workspace = remote::RemoteWorkspace::at(&origin, &project, &repo, &manager);
        call(&workspace, &*state.credentials)
    })
    .await
    .map_err(|error| {
        remote::RemoteSettingsError::command(format!("remote worker failed: {error}"))
    })?
}

/// 打开 remote workspace（决策 6，fail-closed）：以 project[/repo] 识别
/// handshake，成功回 project/repo 显示名与 capability 描述；失败原样回错、
/// 不创建任何 runtime 状态。
#[tauri::command]
async fn remote_open(
    app: tauri::AppHandle,
    connection_id: String,
    target: String,
) -> Result<Value, remote::RemoteOpenFailure> {
    let origin = connection_origin(&app, &connection_id)
        .map_err(remote::RemoteOpenFailure::unknown)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = state.manager_for_connection(&connection_id, &origin);
        let (_, info) = remote::open_workspace(&origin, &target, &manager, &*state.credentials)
            .map_err(remote::RemoteOpenFailure::from)?;
        serde_json::to_value(&info)
            .map_err(|error| remote::RemoteOpenFailure::unknown(error.to_string()))
    })
    .await
    .map_err(|error| {
        remote::RemoteOpenFailure::unknown(format!("remote worker failed: {error}"))
    })?
}

/// remote Workflow 设置快照：`/config` 原文经 desktop-core 文本 seam，并带
/// 与该原文同一 response 的 revision。
#[tauri::command]
async fn remote_read_settings(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
) -> Result<remote::RemoteSettingsSnapshot, remote::RemoteSettingsError> {
    with_remote_settings(app, connection_id, project, repo, |ws, credentials| {
        ws.read_settings(credentials)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn remote_write_workflow_config(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    locale: Option<String>,
    spec_locale: Option<String>,
    tdd: bool,
    audit: bool,
    expected_revision: u64,
) -> Result<u64, remote::RemoteSettingsError> {
    let fields = specseal_desktop_core::settings::WorkflowPolicyFields {
        locale,
        spec_locale,
        tdd,
        audit,
        // 设置页没有 worktree 开关；实际写入值由 desktop-core 从原档回填。
        ..Default::default()
    };
    with_remote_settings(app, connection_id, project, repo, move |ws, credentials| {
        ws.write_workflow_fields(credentials, &fields, expected_revision)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn remote_write_workflow_content(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    context: Option<String>,
    rules: Option<Vec<(String, Vec<String>)>>,
    review: Option<specseal_desktop_core::settings::ReviewConfig>,
    subagent_model: Option<specseal_desktop_core::settings::SubagentModelConfig>,
    expected_revision: u64,
) -> Result<u64, remote::RemoteSettingsError> {
    with_remote_settings(app, connection_id, project, repo, move |ws, credentials| {
        ws.write_workflow_content(
            credentials,
            &content_edit(context, &rules, &review, &subagent_model),
            expected_revision,
        )
    })
    .await
}

#[tauri::command]
async fn remote_write_workflow_schema(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    name: String,
    expected_revision: u64,
) -> Result<u64, remote::RemoteSettingsError> {
    with_remote_settings(app, connection_id, project, repo, move |ws, credentials| {
        ws.write_workflow_schema(credentials, &name, expected_revision)
    })
    .await
}

/// `checkout_root` 是这个 remote 项目绑定的本机工作副本（没有就不带）：有的话，已盖章
/// 变更的「其后有变动」另以 checkout 里的文件判定。
#[tauri::command]
async fn remote_list_changes(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    checkout_root: Option<PathBuf>,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let changes = ws.list_changes(credentials, checkout_root.as_deref()).map_err(|e| e.message)?;
        serde_json::to_value(&changes).map_err(|e| e.to_string())
    })
    .await
}

/// chooser 的 identity-scoped `/scopes` 清单；选定 repo 前不创建 remote session。
#[tauri::command]
async fn remote_scopes(app: tauri::AppHandle, connection_id: String) -> Result<Value, String> {
    let origin = connection_origin(&app, &connection_id)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = state.manager_for_connection(&connection_id, &origin);
        let scopes = remote::list_scopes(&origin, &manager, &*state.credentials)
            .map_err(|error| error.message)?;
        serde_json::to_value(scopes).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Local-to-remote migration: import first, then retain a dated local backup
/// and write the checkout marker before returning the conversion result.
#[tauri::command]
async fn migrate_workspace(
    app: tauri::AppHandle,
    connection_id: String,
    root: PathBuf,
    project: String,
    repo: String,
) -> Result<Value, String> {
    let origin = connection_origin(&app, &connection_id)?;
    let state = app
        .state::<std::sync::Arc<ConnectionsState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = state.manager_for_connection(&connection_id, &origin);
        let result = remote::migrate_workspace(
            &root,
            &origin,
            &project,
            &repo,
            &manager,
            &*state.credentials,
        )?;
        serde_json::to_value(result).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("migration worker failed: {error}"))?
}

/// Resolve local/remote coexistence in favor of server truth. The UI performs
/// a read-only handshake first; this command only retains local openspec/ as a
/// dated backup and never sends an import request.
#[tauri::command]
async fn adopt_remote_workspace(root: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = remote::adopt_remote_workspace(&root)?;
        serde_json::to_value(result).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("remote adoption worker failed: {error}"))?
}

#[tauri::command]
async fn remote_list_specs(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, |ws, credentials| {
        let specs = ws.list_specs(credentials).map_err(|e| e.message)?;
        serde_json::to_value(&specs).map_err(|e| e.to_string())
    })
    .await
}

/// remote 项目的技能档探测（remote-skill-delivery D6）：基准是 Server 提供的技能。
/// Server 没有提供技能时回 null；连不上时为 Err——两者前端都不提示。
#[tauri::command]
async fn probe_remote_assets(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    checkout: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let probe = ws.probe_assets(credentials, std::path::Path::new(&checkout)).map_err(|e| e.message)?;
        Ok(probe.unwrap_or(Value::Null))
    })
    .await
}

/// remote 项目的技能档更新：向 Server 取得全文，再写进 checkout。和本机的更新相同，
/// 写入期间暂停文件监看；向 Server 取得的那一段不暂停——等网络的时间里，其他分页的监看
/// 照常运作。
#[tauri::command]
async fn update_remote_assets(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    checkout: String,
) -> Result<Value, String> {
    let handle = app.clone();
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let checkout = std::path::Path::new(&checkout);
        let served = ws.skills_to_install(credentials, checkout).map_err(|e| e.message)?;
        let install = || served.install(checkout).map_err(|e| e.message);
        match handle.try_state::<WatcherState>() {
            Some(state) => state.while_paused(state.next_ticket(), install),
            None => install(),
        }
    })
    .await
}

#[tauri::command]
async fn remote_list_archived(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, |ws, credentials| {
        let archived = ws.list_archived(credentials).map_err(|e| e.message)?;
        serde_json::to_value(&archived).map_err(|e| e.to_string())
    })
    .await
}

/// 正式规格内文：404 与本地语意一致回 null。
#[tauri::command]
async fn remote_spec_document(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    capability: String,
) -> Result<Option<String>, String> {
    with_remote(
        app,
        connection_id,
        project,
        repo,
        move |ws, credentials| match ws.spec_document(credentials, &capability) {
            Ok(document) => Ok(Some(document.content)),
            Err(error) if error.status == Some(404) => Ok(None),
            Err(error) => Err(error.message),
        },
    )
    .await
}

#[tauri::command]
async fn remote_search_workspace(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    query: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let search = ws
            .search_workspace(credentials, &query)
            .map_err(|e| e.message)?;
        serde_json::to_value(&search).map_err(|e| e.to_string())
    })
    .await
}

/// 封存 artifact 内文：404 与本地语意一致回 null。
#[tauri::command]
async fn remote_archived_document(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    dated_name: String,
    artifact: String,
) -> Result<Option<String>, String> {
    with_remote(
        app,
        connection_id,
        project,
        repo,
        move |ws, credentials| match ws.archived_document(credentials, &dated_name, &artifact) {
            Ok(document) => Ok(Some(document.content)),
            Err(error) if error.status == Some(404) => Ok(None),
            Err(error) => Err(error.message),
        },
    )
    .await
}

#[tauri::command]
async fn remote_archived_capabilities(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    dated_name: String,
) -> Result<Vec<String>, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.archived_capabilities(credentials, &dated_name)
            .map_err(|error| error.message)
    })
    .await
}

#[tauri::command]
async fn remote_status(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let status = ws
            .change_status(credentials, &change)
            .map_err(|e| e.message)?;
        serde_json::to_value(&status).map_err(|e| e.to_string())
    })
    .await
}

/// artifact 内文：404（change 或 artifact 不存在）与本地语意一致回 null。
#[tauri::command]
async fn remote_document(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    artifact: String,
) -> Result<Option<String>, String> {
    with_remote(
        app,
        connection_id,
        project,
        repo,
        move |ws, credentials| match ws.document(credentials, &change, &artifact) {
            Ok(doc) => Ok(Some(doc.content)),
            Err(e) if e.status == Some(404) => Ok(None),
            Err(e) => Err(e.message),
        },
    )
    .await
}

/// 远程活工单：`GET /changes/{name}/{station}` 已是结构化 rounds，经
/// `remote::station_ticket_payload` 交给与本机同一个组装函数；404 与本地语意一致回
/// null，不认得的 rules baseline 同样 null。未知站别不拼 URL，直接 null。
#[tauri::command]
async fn remote_station_ticket(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    station: String,
) -> Result<Option<Value>, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let Some(st) = specseal_desktop_core::query::station_by_noun(&station) else {
            return Ok(None);
        };
        ws.station_ticket(credentials, &change, st.noun)
            .map(|ticket| ticket.and_then(remote::station_ticket_payload))
            .map_err(|error| error.message)
    })
    .await
}

/// 远程封存工单：封存文档端点只给原文，取回后交引擎解析（desktop core 的
/// `ticket_json_from_text`）；404 回 null，格式坏掉同样 null。
#[tauri::command]
async fn remote_archived_station_ticket(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    dated_name: String,
    station: String,
) -> Result<Option<Value>, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let Some(st) = specseal_desktop_core::query::station_by_noun(&station) else {
            return Ok(None);
        };
        match ws.archived_document(credentials, &dated_name, st.doc) {
            Ok(document) => Ok(specseal_desktop_core::query::ticket_json_from_text(
                st.noun,
                &document.content,
            )),
            Err(error) if error.status == Some(404) => Ok(None),
            Err(error) => Err(error.message),
        }
    })
    .await
}

#[tauri::command]
async fn remote_set_task_done(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    task: String,
    done: bool,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.set_task_done(credentials, &change, &task, done)
            .map_err(|e| e.message)
    })
    .await
}

/// 组合类批量写回（决策 1 (b)）：中途失败中止并回报已完成笔数。
#[tauri::command]
async fn remote_set_all_tasks(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    done: bool,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.set_all_tasks(credentials, &change, done)
            .map(|_| ())
            .map_err(|failure| {
                format!(
                    "批量写回中止（已完成 {} 笔）：{}",
                    failure.completed, failure.error.message
                )
            })
    })
    .await
}

/// 两个 carry 旗标是封存对话框「照样带走」的选择；一般封存不带（读作 false）。
#[tauri::command]
async fn remote_archive(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    carry_review: Option<bool>,
    carry_verify: Option<bool>,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let archived = ws
            .archive(credentials, &change, carry_review.unwrap_or(false), carry_verify.unwrap_or(false))
            .map_err(|e| e.message)?;
        serde_json::to_value(&archived).map_err(|e| e.to_string())
    })
    .await
}

/// 封存对话框的「放弃审查／放弃验证」：删掉 remote 变更该站的工单。未知站别不拼 URL。
#[tauri::command]
async fn remote_discard_station(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    station: String,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let Some(st) = specseal_desktop_core::query::station_by_noun(&station) else {
            return Err(format!("unknown station: {station}"));
        };
        ws.discard_station(credentials, &change, st.noun).map_err(|e| e.message)
    })
    .await
}

#[tauri::command]
async fn remote_validate(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let result = ws.validate(credentials, &change).map_err(|e| e.message)?;
        serde_json::to_value(&result).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn remote_analyze(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let report = ws.analyze(credentials, &change).map_err(|e| e.message)?;
        serde_json::to_value(&report).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn remote_revert_change_to_proposed(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.revert_change_to_proposed(credentials, &change).map_err(|e| match e.evidence {
            // 409 守门证据 → 与本地 bridge 同一转译(前端对话框单一消费形状)。
            Some(ev) => specseal_desktop_core::manage::revert_blocked_error(
                ev.checked_tasks,
                &ev.touched_files,
            ),
            None => e.message,
        })
    })
    .await
}

/// 认领一个 change（RemoteOnly）。已被他人持有时 server 回 409 refused，消息
/// 带持有人与建议动作——原样交前端，沿既有失败呈现路径。
#[tauri::command]
async fn remote_claim(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.claim(credentials, &change).map(|_| ()).map_err(|e| e.message)
    })
    .await
}

/// 前置的添加与移除（add-change-plan-remote D7）：单行委派；守门失败的 409
/// 消息是 server 转发的引擎原文，原样交前端成单行错误。
#[tauri::command]
async fn remote_set_change_depends(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    on: Vec<String>,
    remove: bool,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.set_depends(credentials, &change, &on, remove).map_err(|e| e.message)
    })
    .await
}

#[tauri::command]
async fn remote_delete_change(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    force: bool,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.delete_change(credentials, &change, force)
            .map_err(|e| e.message)
    })
    .await
}

#[tauri::command]
async fn remote_move_task(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    change: String,
    from: usize,
    to: usize,
    before: Option<bool>,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.move_task(credentials, &change, from, to, before)
            .map_err(|e| e.message)
    })
    .await
}

/// 看板拖排直达（remote-board-order 决策 5）：邻居寻址与本地 reorder_card
/// 同形；顺序写入 scope 的 board resource，不触碰卡片 meta。
#[tauri::command]
async fn remote_reorder_card(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    kind: String,
    id: String,
    prev_id: Option<String>,
    next_id: Option<String>,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.reorder_card(
            credentials,
            &kind,
            &id,
            prev_id.as_deref(),
            next_id.as_deref(),
        )
        .map_err(|e| e.message)
    })
    .await
}

#[tauri::command]
async fn remote_list_discussions(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, |ws, credentials| {
        let lists = ws.list_discussions(credentials).map_err(|e| e.message)?;
        serde_json::to_value(&lists).map_err(|e| e.to_string())
    })
    .await
}

/// 讨论记录全文与其刀（`{ content, cuts }`）：404 与本地语意一致回 null。
#[tauri::command]
async fn remote_discussion_document(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    slug: String,
) -> Result<Option<remote::RemoteDiscussionDocument>, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.discussion_document(credentials, &slug).map_err(|e| e.message)
    })
    .await
}

#[tauri::command]
async fn remote_promote_discussion(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    slug: String,
    name: Option<String>,
) -> Result<Value, String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        let promoted = ws
            .promote_discussion(credentials, &slug, name.as_deref())
            .map_err(|e| e.message)?;
        serde_json::to_value(&promoted).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn remote_archive_discussion(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
    slug: String,
) -> Result<(), String> {
    with_remote(app, connection_id, project, repo, move |ws, credentials| {
        ws.archive_discussion(credentials, &slug)
            .map(|_| ())
            .map_err(|e| e.message)
    })
    .await
}

/// remote 事件订阅的生产退避串行（决策 5：指数退避、封顶 30s）。
const REMOTE_BACKOFF: [std::time::Duration; 6] = [
    std::time::Duration::from_millis(500),
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(5),
    std::time::Duration::from_secs(10),
    std::time::Duration::from_secs(30),
];

/// remote session 的 locator key（与 TS session.ts 的 locatorKey 同构）。
fn remote_locator_key(connection_id: &str, project: &str, repo: &str) -> String {
    format!("remote:{connection_id}/{project}/{repo}")
}

/// 注册 remote 分页的事件订阅（决策 3）：同 connection 同 scope 的 sessions
/// 共用单一 SSE 流；invalidate 即 emit remote-workspace-changed（payload＝
/// locator key），前端据此经 Query 重读。
/// connectionId → origin 的查找要读 connections.json，故整段走 spawn_blocking。
#[tauri::command]
async fn remote_watch(
    app: tauri::AppHandle,
    connection_id: String,
    project: String,
    repo: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let events = app
            .state::<std::sync::Arc<event_manager::EventManager>>()
            .inner()
            .clone();
        let key = remote_locator_key(&connection_id, &project, &repo);
        // 注册前的失败要入帐（register_failed）：前端 unmount 照样退订，
        // 没入帐的失败会让那笔退订毒害同 key 的下一次订阅。
        let origin = match connection_origin(&app, &connection_id) {
            Ok(origin) => origin,
            Err(e) => {
                events.register_failed(&key);
                return Err(e);
            }
        };
        let state = app
            .state::<std::sync::Arc<ConnectionsState>>()
            .inner()
            .clone();
        let base = format!("{origin}/api/specseal/v1/projects/{project}");
        let manager = state.manager_for_connection(&connection_id, &origin);
        let sub_state = state.clone();
        let sub_manager = manager.clone();
        let sub_base = base.clone();
        let sub_repo = repo.clone();
        let etag_repo = repo;
        events.register(
            &key,
            move |last| {
                sub_manager.execute(&*sub_state.credentials, |token| {
                    specseal_remote::events::subscribe(&sub_base, token, Some(&sub_repo), last)
                })
            },
            move || {
                manager.execute(&*state.credentials, |token| {
                    specseal_remote::events::sync_state(&base, token, Some(&etag_repo))
                })
            },
            REMOTE_BACKOFF.to_vec(),
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("remote_watch worker failed: {e}"))?
}

/// 退出 remote 分页的事件订阅：最后一个 session 退出即收束该流。
#[tauri::command]
fn remote_unwatch(app: tauri::AppHandle, connection_id: String, project: String, repo: String) {
    let events = app.state::<std::sync::Arc<event_manager::EventManager>>();
    events.unregister(&remote_locator_key(&connection_id, &project, &repo));
}

/// 系统匣面板 toggle（tray-status-menu「面板样式」）：委派 panel 模块（Linux 恒回 Err，
/// 系统匣样式恒为原生菜单、不可达，此为守门）。macOS 维持同步——NSPanel 操作须在主线程。
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn toggle_tray_panel(app: tauri::AppHandle) -> Result<(), String> {
    panel::toggle(&app)
}

/// Windows 版必须 async：首次打开会创建面板窗口，在同步 command 内置立窗口 Windows 会因
/// WebView2 死结（Tauri `WebviewWindowBuilder::new` 的 Known issues；tray-panel-windows design D6）。
#[cfg(target_os = "windows")]
#[tauri::command]
async fn toggle_tray_panel(app: tauri::AppHandle) -> Result<(), String> {
    panel::toggle(&app)
}

/// 面板交接主窗口前先收合（tray-status-menu「面板交接主窗口后鼠标交互完整」）：
/// 委派 panel 模块的幂等 hide（Linux 无面板，无事）——唤起主窗口的前端路径在各平台共用，
/// 此命令不得成为阻断点。不会失败，故无回传值。
#[tauri::command]
fn hide_tray_panel(app: tauri::AppHandle) {
    panel::hide(&app);
}

/// 结束 app（tray-status-menu「打开窗口与结束动作」）：webview 无法自行结束
/// 行程的能力桥接——面板动作区「结束」经此命令结束整个 app。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // specseal 网址（desktop-deep-link）：Windows、Linux 再次启动（含操作系统带网址启动）时交给
    // 运行中的 app——插件的 deep-link 功能先把网址转成前端 onOpenUrl 事件，callback 再把主窗口
    // 带到前景。插件要求排在所有插件之前。macOS 由系统确保单一实例，网址走 RunEvent::Opened。
    // 唤起步骤与前端 tray.ts 的 openMainWindow 相同（先收合面板）；不带网址的再次启动不会经过前端，
    // 所以这里要自己做一次。
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        panel::hide(app);
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // macOS 面板相依：positioner 供 tray 相对定位、nspanel 供不抢焦点的 NSPanel 容器。
    // Windows 面板由 panel 模块依图标位置自行定位（tray-panel-windows design D3），不需插件。
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_nspanel::init());
    builder
        .setup(|app| {
            // 监看槽位（决策 5）：启动仅注册空槽——前端还原分页后以
            // watch_workspace 显式挂上活跃项目（监看与数据加载同由前端
            // session 驱动；创建失败仅记录，app 照常、只失去自动刷新）。
            app.manage(WatcherState {
                tickets: std::sync::atomic::AtomicU64::new(0),
                slot: std::sync::Mutex::new(watch::WatchSlot::new()),
            });
            // 连接层：credential 生产出入口＝OS Keychain；access token 内存持有。
            let state_emitter = app.handle().clone();
            app.manage(std::sync::Arc::new(ConnectionsState {
                credentials: Box::new(specseal_remote::credentials::KeyringCredentialStore),
                managers: std::sync::Mutex::new(std::collections::HashMap::new()),
                state_observer: std::sync::Arc::new(move |event| {
                    let _ = state_emitter.emit(remote::REMOTE_CONNECTION_STATE_EVENT, event);
                }),
                logins: connections::LoginCancels::default(),
            }));
            // remote 事件中枢：invalidate → remote-workspace-changed（payload＝
            // locator key），前端 session 据此过滤重读。
            let emitter = app.handle().clone();
            app.manage(std::sync::Arc::new(event_manager::EventManager::new(
                move |key: String| {
                    let _ = emitter.emit("remote-workspace-changed", key);
                },
            )));
            // 触摸板滑动返回的手指按下／离开信号（desktop-swipe-back-finger-lift）：只在 macOS 提供。
            #[cfg(target_os = "macos")]
            trackpad_gesture::install(app.handle());
            // Linux 的 AppImage 不经安装程序，运行期补登 specseal 网址格式（desktop-deep-link）；
            // 失败只记录，app 照常、只是网址开不了。
            #[cfg(target_os = "linux")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("specseal-desktop: specseal:// scheme registration failed: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            cli_install_probe,
            cli_deploy,
            cli_zprofile_append,
            list_changes,
            list_specs,
            status,
            document,
            spec_document,
            list_manual_pages,
            get_manual_page,
            search_workspace,
            change_capabilities,
            change_meta,
            delete_change,
            revert_change_to_proposed,
            set_task_done,
            set_all_tasks,
            move_task,
            reorder_card,
            set_change_depends,
            depends_candidates,
            validate,
            analyze,
            archive,
            archive_carry,
            discard_verify,
            discard_review,
            archived_changes,
            archived_document,
            archived_capabilities,
            station_ticket,
            archived_station_ticket,
            list_discussions,
            discussion_document,
            promote_discussion,
            archive_discussion,
            open_project,
            init_project,
            adopt_project,
            startup_dir,
            project_stats,
            probe_assets,
            update_assets,
            probe_remote_assets,
            update_remote_assets,
            watch_workspace,
            watch_checkout_skills,
            read_settings,
            write_app_tools,
            write_workflow_config,
            write_workflow_content,
            read_schemas,
            write_workflow_schema,
            fork_schema,
            init_schema,
            reveal_in_folder,
            open_path,
            document_location,
            discussion_location,
            spec_location,
            manual_location,
            archived_document_location,
            fs_actions::open_in_terminal,
            fs_actions::open_in_editor,
            delete_schema,
            connection_list,
            connection_add,
            inspect_checkout,
            bind_checkout,
            connection_remove,
            connection_login_start,
            connection_login_cancel,
            pat_login,
            connection_state,
            connection_logout,
            remote_open,
            remote_read_settings,
            remote_write_workflow_config,
            remote_write_workflow_content,
            remote_write_workflow_schema,
            remote_scopes,
            migrate_workspace,
            adopt_remote_workspace,
            remote_list_changes,
            remote_list_specs,
            remote_list_archived,
            remote_spec_document,
            remote_search_workspace,
            remote_archived_document,
            remote_archived_capabilities,
            remote_status,
            remote_document,
            remote_station_ticket,
            remote_archived_station_ticket,
            remote_set_task_done,
            remote_set_all_tasks,
            remote_archive,
            remote_discard_station,
            remote_validate,
            remote_analyze,
            remote_claim,
            remote_set_change_depends,
            remote_delete_change,
            remote_revert_change_to_proposed,
            remote_move_task,
            remote_reorder_card,
            remote_list_discussions,
            remote_discussion_document,
            remote_promote_discussion,
            remote_archive_discussion,
            remote_watch,
            remote_unwatch,
            toggle_tray_panel,
            hide_tray_panel,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Specseal desktop app");
}
