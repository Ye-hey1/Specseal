//! 规格文件夹文件监看（design D3）：递归监看探索出的 spec 目录树，事件合并
//! 去抖后以回呼通知——回呼不带参数，订阅端一律整批 refresh，不做细粒度 diff。
//! 回呼式内核与 Tauri 事件发送分离：本模块不知道 Tauri 存在，lib.rs 的
//! watch_workspace command 把回呼接到 `workspace-changed` 事件上（payload 为
//! 被监看的 root，由挂载处闭包补上——workspace-session 决策 5）。
//!
//! 监看目标由 [`resolve_watch_targets`] 解析：自起点向上探索 specseal 项目
//! （与查找指令的 `Workspace::discover` 同源），取其实际 spec 目录——监看根
//! SHALL 与查找一致，不以未经探索的启动 cwd 拼接固定目录名。`.specseal/`
//! （缓存）与其他兄弟目录天然不在范围内，无自循环。

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

/// 存活期间持续监看；drop 即停止（app 生命周期内由 Tauri state 持有）。
pub struct WorkspaceWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// 事件路径的比对用范式：已删除的路径 canonicalize 必败，退一步范式
/// 父目录再接回文件名（哨兵比对的父目录 .git 恒存在）；再不行原样退回。
fn normalized_for_match(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
        if let Ok(c) = parent.canonicalize() {
            return c.join(name);
        }
    }
    p.to_path_buf()
}

/// `event` 相对于 `roots` 其中一个的路径：先比范式后的事件路径，再比事件原本的路径。
/// 连上层都已经不在的路径无法范式（[`normalized_for_match`] 这时才原样退回），在 Windows 上
/// 它的前缀和范式后的根（`\\?\` 形式）对不上——所以挂载时给的根也要比。都比不上时为 None。
fn relative_under(roots: &[PathBuf], event: &Path) -> Option<PathBuf> {
    let normalized = normalized_for_match(event);
    roots
        .iter()
        .find_map(|root| normalized.strip_prefix(root).or_else(|_| event.strip_prefix(root)).ok())
        .map(Path::to_path_buf)
}

/// 自 `start` 向上探索 specseal 项目，回传所有监看目标——第一项为其 spec 目录，
/// 其后为 worktree 流程下的副本 change 目录与 worktree 登记簿（推导归 desktop-core）。
/// 探索不到项目时回传可记录的 `Err`（含起点路径）——调用端记录后照常运作，
/// 仅失去自动刷新。
pub fn resolve_watch_targets(start: &Path) -> Result<Vec<PathBuf>, String> {
    let targets = specseal_desktop_core::query::watch_targets_at(start);
    if targets.is_empty() {
        return Err(format!("no specseal project found from {}", start.display()));
    }
    Ok(targets)
}

/// 递归监看已解析的目标；去抖窗口内的事件合并为一次 `on_change()` 调用。
/// 第一个目标（spec 目录）不存在或创建失败时回传可记录的 `Err`；其后的
/// worktree 目标为尽力而为——推导与实际挂载之间 worktree 可能已被移除，
/// 少监看一个路径只是少一次自动刷新，不该让整个监看失败。
///
/// 例外：名为 `.git` 的目标是「登记簿出生前」的哨兵（推导层在
/// `.git/worktrees/` 尚不存在时以它代位），非递归挂载——只等直接子目录
/// worktrees/ 的创建事件，不吞 objects/ 的海量写入。
pub fn watch_targets(
    targets: &[PathBuf],
    debounce: Duration,
    on_change: impl Fn() + Send + 'static,
) -> Result<WorkspaceWatcher, String> {
    let Some(target) = targets.first() else {
        return Err("no watch target".to_string());
    };
    let is_sentinel = |p: &Path| p.file_name() == Some(std::ffi::OsStr::new(".git"));
    // 哨兵目标只等 worktrees/ 出生；index、HEAD 等 .git 直接子项几乎每个
    // git 指令都写，这些事件于事件层过滤，不变成看板空刷新。比对前两侧都
    // 范式——FSEvents 回报解析后路径，监看目标却可能经 symlink 或含 `..`。
    let sentinel = targets
        .iter()
        .skip(1)
        .find(|p| is_sentinel(p))
        .map(|p| p.canonicalize().unwrap_or_else(|_| p.clone()));
    let relevant = move |event: &Path| match &sentinel {
        Some(git_dir) => {
            let path = normalized_for_match(event);
            path != *git_dir
                && !(path.parent() == Some(git_dir.as_path())
                    && path.file_name() != Some(std::ffi::OsStr::new("worktrees")))
        }
        None => true,
    };
    let mounts: Vec<(PathBuf, RecursiveMode)> = std::iter::once((target.clone(), RecursiveMode::Recursive))
        .chain(targets.iter().skip(1).map(|extra| {
            let mode = if is_sentinel(extra) { RecursiveMode::NonRecursive } else { RecursiveMode::Recursive };
            (extra.clone(), mode)
        }))
        .collect();
    watch_mounts(&mounts, relevant, debounce, on_change)
}

/// 挂上 `mounts`，每个挂载点带自己的方式；去抖窗口内只要有一个事件的路径通过 `relevant`，
/// 就合并为一次 `on_change()`。第一个挂载点不存在或创建失败时回传可记录的 `Err`；其后的
/// 挂载点为尽力而为（推导与实际挂载之间文件夹可能已被移除），不存在的略过。
fn watch_mounts(
    mounts: &[(PathBuf, RecursiveMode)],
    relevant: impl Fn(&Path) -> bool + Send + 'static,
    debounce: Duration,
    on_change: impl Fn() + Send + 'static,
) -> Result<WorkspaceWatcher, String> {
    let Some((first, first_mode)) = mounts.first() else {
        return Err("no watch target".to_string());
    };
    if !first.is_dir() {
        return Err(format!("watch target missing: {}", first.display()));
    }
    let mut debouncer = new_debouncer(debounce, move |result: DebounceEventResult| {
        // 错误批量不通知也不中断监看。
        let Ok(events) = &result else { return };
        if events.iter().any(|e| relevant(&e.path)) {
            on_change();
        }
    })
    .map_err(|e| format!("watcher setup failed: {e}"))?;
    debouncer
        .watcher()
        .watch(first, *first_mode)
        .map_err(|e| format!("watch {} failed: {e}", first.display()))?;
    for (extra, mode) in mounts.iter().skip(1).filter(|(p, _)| p.is_dir()) {
        let _ = debouncer.watcher().watch(extra, *mode);
    }
    Ok(WorkspaceWatcher {
        _debouncer: debouncer,
    })
}

/// 活跃监看与其目标集合的槽位：重挂时目标集合不变即沿用原监看。
///
/// 重挂由 workspace-changed 事件驱动（前端每次刷新顺手重挂），而 Linux
/// inotify 的挂载走访本身会变成一批事件——每次都整颗重建就是事件循环。
/// 比对后只在拓扑真的改变（worktree 增减、登记簿出生）时重建。
///
/// async 化后重挂跑在线程池，两条链（activation 与事件驱动重挂）可交错：
/// 调用端取号后传入 `ticket`，序号较小的慢工视为陈旧、直接略过，不得反超
/// 较新的挂载。
pub struct WatchSlot {
    current: Option<(Vec<PathBuf>, WorkspaceWatcher)>,
    last_ticket: u64,
    /// [`WatchSlot::pause`] 到 [`WatchSlot::resume`] 之间不挂任何监看。
    paused: bool,
}

impl WatchSlot {
    pub fn new() -> WatchSlot {
        WatchSlot {
            current: None,
            last_ticket: 0,
            paused: false,
        }
    }

    /// 解析 `start` 的监看目标并视需要重挂；回传是否重建。陈旧序号略过并回
    /// `Ok(false)`。解析或挂载失败时清空槽位并回 `Err`——调用端记录后照常
    /// 运作，仅失去自动刷新。
    pub fn rearm(
        &mut self,
        ticket: u64,
        start: &Path,
        debounce: Duration,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<bool, String> {
        if self.paused || ticket < self.last_ticket {
            return Ok(false);
        }
        let targets = match resolve_watch_targets(start) {
            Ok(t) => t,
            Err(e) => {
                self.current = None;
                return Err(e);
            }
        };
        self.rearm_with_targets(ticket, targets, debounce, on_change)
    }

    /// 挂上有 checkout 的 remote 项目的技能档监看（remote-skill-delivery D8），视需要重挂；
    /// 回传是否重建。目标由 desktop-core 推导：checkout 的根（不递归）与各工具的技能目录；
    /// 事件只在和技能档探测有关时通知——根底下的 `.git`、原代码文件夹的变动不算。序号、
    /// 暂停与「目标不变就沿用原监看」的规则和 [`WatchSlot::rearm`] 相同。
    pub fn rearm_checkout(
        &mut self,
        ticket: u64,
        checkout: &Path,
        debounce: Duration,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<bool, String> {
        if self.paused || ticket < self.last_ticket {
            return Ok(false);
        }
        self.last_ticket = ticket;
        let targets = specseal_desktop_core::project::skill_watch_targets_at(checkout);
        let mounted: Vec<PathBuf> = targets.mounts.iter().map(|mount| mount.path.clone()).collect();
        if matches!(&self.current, Some((prev, _)) if *prev == mounted) {
            return Ok(false);
        }
        let mounts: Vec<(PathBuf, RecursiveMode)> = targets
            .mounts
            .iter()
            .map(|mount| {
                let mode = if mount.recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
                (mount.path.clone(), mode)
            })
            .collect();
        // 事件回报的路径可能是解析后的形式，也可能是挂载时给的形式：两种根都拿来比。
        let roots = [checkout.canonicalize().unwrap_or_else(|_| checkout.to_path_buf()), checkout.to_path_buf()];
        let relevant =
            move |event: &Path| relative_under(&roots, event).is_some_and(|relative| targets.concerns(&relative));
        match watch_mounts(&mounts, relevant, debounce, on_change) {
            Ok(watcher) => {
                self.current = Some((mounted, watcher));
                Ok(true)
            }
            Err(e) => {
                self.current = None;
                Err(e)
            }
        }
    }

    /// 暂停监看（desktop-spec-dir-migration D2）：drop 目前的监看，到 [`WatchSlot::resume`]
    /// 之前任何重挂都不挂回（在途的 workspace-changed、切回分页都会重挂）——更新可能把规格
    /// 文件夹改名，Windows 上活着的监看会挡住改名。推进序号，暂停前取号的重挂之后也略过；
    /// 恢复后的 [`WatchSlot::rearm`] 必定重建，依新的规格文件夹解析。
    pub fn pause(&mut self, ticket: u64) {
        self.last_ticket = self.last_ticket.max(ticket);
        self.current = None;
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    /// 判等基准是「可挂载集合」（首项＋其余存在的目录），不是解析集合——
    /// 挂载时被存在性过滤略过的目录（如 checkout 中的 worktree 副本），
    /// 之后出现必须触发重建补挂，否则它永久失去监看。
    fn rearm_with_targets(
        &mut self,
        ticket: u64,
        targets: Vec<PathBuf>,
        debounce: Duration,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<bool, String> {
        if ticket < self.last_ticket {
            return Ok(false);
        }
        self.last_ticket = ticket;
        let mountable: Vec<PathBuf> = targets
            .iter()
            .enumerate()
            .filter(|(i, p)| *i == 0 || p.is_dir())
            .map(|(_, p)| p.clone())
            .collect();
        if matches!(&self.current, Some((prev, _)) if *prev == mountable) {
            return Ok(false);
        }
        match watch_targets(&targets, debounce, on_change) {
            Ok(watcher) => {
                self.current = Some((mountable, watcher));
                Ok(true)
            }
            Err(e) => {
                self.current = None;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    struct TempRoot(std::path::PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> TempRoot {
            // 不用系统 tmpdir：CI 上系统调度（如 systemd-tmpfiles）会遍历 /tmp，
            // 而 notify 的 inotify 遮罩含 OPEN/ATTRIB——外部行程 open 监看树内的
            // 目录就会变成事件，让计数型断言被环境杂讯击穿。target/ 无人遍历。
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("..")
                .join("target")
                .join(format!("specseal-watch-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("specseal").join("changes")).unwrap();
            TempRoot(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_inside_the_spec_folder_coalesce_to_at_most_one_notification_per_file() {
        let root = TempRoot::new("coalesce");
        // demo/ 先于监看存在：Linux inotify 对新目录要事件后补挂 watch，目录
        // 创建与其内容写入会被拆进不同 debounce 批量，计数断言只能创建在
        // 已被监看的目录上（macOS FSEvents 无此拆分，先前不可见）。
        let changes = root.0.join("specseal").join("changes");
        std::fs::create_dir_all(changes.join("demo")).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        let _watcher = watch_targets(
            &[root.0.join("specseal")],
            Duration::from_millis(300),
            move || {
                h.fetch_add(1, Ordering::SeqCst);
            },
        )
        .expect("watcher starts on an existing spec folder");
        // 监看就绪缓冲（Windows ReadDirectoryChangesW 挂载异步），并让 Linux 的挂载
        // 自我通知流完：notify 以 WalkDir 递归补挂 watch，父目录的 OPEN 遮罩把走访
        // 本身变成一批事件（FSEvents／RDCW 不报 open，仅 inotify 可见）。
        std::thread::sleep(Duration::from_millis(600));
        hits.store(0, Ordering::SeqCst); // 丢弃挂载批量，只计入动作后的通知

        // 一波连续写入（外部 CLI 动词的典型效果：meta＋tasks）。
        std::fs::write(
            changes.join("demo").join(".openspec.yaml"),
            "schema: spec-driven\n",
        )
        .unwrap();
        std::fs::write(changes.join("demo").join("tasks.md"), "- [ ] 1.1 t\n").unwrap();

        std::thread::sleep(Duration::from_millis(2000));
        // debouncer 逐路径计时：闹钟响时只送出「最后事件已满 debounce」的路径，
        // 第二个文件的事件若比线程醒来的延迟晚到，就留到下一轮再送（Windows
        // 上 Defender 于关档时扫描，两档事件间隔可达数十毫秒）。套件对跨档合并
        // 不保证恰一次，只保证每个路径至多一次：两档至少 4 个原始事件，收敛到
        // 1～2 次通知即证明去抖生效。
        let n = hits.load(Ordering::SeqCst);
        assert!(
            (1..=2).contains(&n),
            "a burst of writes to two files must coalesce to at most one notification per file, got {n}"
        );
    }

    #[test]
    fn writes_outside_the_spec_folder_do_not_notify() {
        let root = TempRoot::new("outside");
        std::fs::create_dir_all(root.0.join(".specseal")).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        let _watcher = watch_targets(
            &[root.0.join("specseal")],
            Duration::from_millis(200),
            move || {
                h.fetch_add(1, Ordering::SeqCst);
            },
        )
        .expect("watcher starts");
        // 同 coalesce 测试：等挂载自我通知（Linux inotify 的 OPEN 遮罩）流完后归零。
        std::thread::sleep(Duration::from_millis(600));
        hits.store(0, Ordering::SeqCst);

        // 缓存与项目杂项都在规格文件夹外——不得触发。
        std::fs::write(root.0.join(".specseal").join("desktop-cache.db"), "cache").unwrap();
        std::fs::write(root.0.join("note.txt"), "not a spec doc").unwrap();

        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "writes outside the spec folder must not notify"
        );
    }

    #[test]
    fn the_git_sentinel_is_watched_non_recursively() {
        // .git 哨兵只为等 worktrees/ 出生：递归挂载会吞下 objects/ 的海量写入，
        // 每次 git 操作都变成看板整批 refresh。深层写入不得通知、直接子目录
        // 的创建（登记簿出生）必须通知。
        let root = TempRoot::new("git-sentinel");
        let git_dir = root.0.join(".git");
        std::fs::create_dir_all(git_dir.join("objects").join("aa")).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        let _watcher = watch_targets(
            &[root.0.join("specseal"), git_dir.clone()],
            Duration::from_millis(200),
            move || {
                h.fetch_add(1, Ordering::SeqCst);
            },
        )
        .expect("watcher starts");
        std::thread::sleep(Duration::from_millis(600));
        hits.store(0, Ordering::SeqCst); // 丢弃挂载批量

        std::fs::write(git_dir.join("objects").join("aa").join("blob"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            ".git 深层写入不得通知（哨兵非递归）"
        );

        // index、HEAD 等 .git 直接子档几乎每个 git 指令都写——哨兵只等
        // worktrees/ 出生，其余直接子项的事件不得变成看板空刷新。
        std::fs::write(git_dir.join("index"), "idx").unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            ".git 直接子档写入不得通知（哨兵只等 worktrees/ 出生）"
        );

        std::fs::create_dir_all(git_dir.join("worktrees")).unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert!(
            hits.load(Ordering::SeqCst) >= 1,
            "登记簿出生（.git 直接子目录创建）必须通知"
        );
    }

    #[test]
    fn rearm_rebuilds_when_a_previously_missing_target_dir_appears() {
        // worktree 副本的 change 目录可能晚于 facts 出现（大 repo checkout 慢于
        // 去抖窗）：挂载时被存在性过滤略过的目录，之后出现必须触发重建补挂，
        // 否则该目录永久失去监看。判等基准是「可挂载集合」，不是解析集合。
        let root = TempRoot::new("rearm-late");
        let late = root.0.join("late-dir");
        let targets = vec![root.0.join("specseal"), late.clone()];
        let mut slot = WatchSlot::new();
        let rebuilt = slot
            .rearm_with_targets(1, targets.clone(), Duration::from_millis(200), || {})
            .expect("first mount");
        assert!(rebuilt, "首次必为重建");
        let rebuilt = slot
            .rearm_with_targets(2, targets.clone(), Duration::from_millis(200), || {})
            .expect("same targets resolve");
        assert!(!rebuilt, "目录仍缺席、可挂载集合不变须沿用");

        std::fs::create_dir_all(&late).unwrap();
        let rebuilt = slot
            .rearm_with_targets(3, targets.clone(), Duration::from_millis(200), || {})
            .expect("rearm after the dir appears");
        assert!(rebuilt, "晚出生的目录出现＝可挂载集合改变，须重建补挂");
        let rebuilt = slot
            .rearm_with_targets(4, targets, Duration::from_millis(200), || {})
            .expect("stable targets resolve");
        assert!(!rebuilt, "补挂后无变化须沿用");
    }

    #[test]
    fn rearm_keeps_the_watcher_when_targets_are_unchanged() {
        // 事件驱动的重挂若每次都整颗重建，Linux inotify 的挂载自我通知会形成
        // 事件循环——目标集合不变就必须保留原监看。
        let root = TempRoot::new("rearm");
        let mut slot = WatchSlot::new();
        let rebuilt = slot
            .rearm(1, &root.0, Duration::from_millis(200), || {})
            .expect("first rearm mounts");
        assert!(rebuilt, "首次必为重建");
        let rebuilt = slot
            .rearm(2, &root.0, Duration::from_millis(200), || {})
            .expect("second rearm resolves");
        assert!(!rebuilt, "目标集合不变须沿用原监看");

        // 拓扑改变（git repo 出生 → 哨兵进场）→ 重建。
        std::fs::create_dir_all(root.0.join(".git")).unwrap();
        let rebuilt = slot
            .rearm(3, &root.0, Duration::from_millis(200), || {})
            .expect("rearm after topology change");
        assert!(rebuilt, "目标集合改变须重建监看");
    }

    #[test]
    fn a_stale_ticket_never_overrides_a_newer_rearm() {
        // async 化后 activation 与事件驱动重挂是两条可交错的链：旧 root 的慢
        // 挂载后完成时不得反超新 root——序号较小＝陈旧，直接略过。
        let root_new = TempRoot::new("ticket-new");
        let root_old = TempRoot::new("ticket-old");
        let mut slot = WatchSlot::new();
        let newer = slot
            .rearm(2, &root_new.0, Duration::from_millis(200), || {})
            .expect("newer rearm mounts");
        assert!(newer, "新 root 挂载必为重建");
        let stale = slot
            .rearm(1, &root_old.0, Duration::from_millis(200), || {})
            .expect("stale rearm is a no-op, not an error");
        assert!(!stale, "陈旧序号不得重建");
        // 槽位仍在新 root 上：同 root 再挂（新序号）应回报「未重建」。
        let unchanged = slot
            .rearm(3, &root_new.0, Duration::from_millis(200), || {})
            .expect("re-rearm on the current root");
        assert!(!unchanged, "槽位必须仍监看较新的 root");
    }

    #[test]
    fn rearm_after_the_spec_folder_is_renamed_watches_the_new_folder() {
        // desktop-spec-dir-migration D2：更新前暂停监看，openspec/ 改名为 specseal/ 后
        // 重挂重新解析出 specseal/，其下的写入照样通知。
        let root = TempRoot::new("renamed");
        std::fs::write(root.0.join(".specseal.yaml"), "tools: [claude]\n").unwrap();
        std::fs::rename(root.0.join("specseal"), root.0.join("openspec")).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let mut slot = WatchSlot::new();
        let h = Arc::clone(&hits);
        slot.rearm(1, &root.0, Duration::from_millis(200), move || {
            h.fetch_add(1, Ordering::SeqCst);
        })
        .expect("mounts on openspec/");

        slot.pause(2);
        std::fs::rename(root.0.join("openspec"), root.0.join("specseal")).unwrap();
        slot.resume();
        let h = Arc::clone(&hits);
        let rebuilt = slot
            .rearm(3, &root.0, Duration::from_millis(200), move || {
                h.fetch_add(1, Ordering::SeqCst);
            })
            .expect("rearm resolves specseal/");
        assert!(rebuilt, "暂停后的重挂必为重建");
        assert_eq!(resolve_watch_targets(&root.0).unwrap()[0], root.0.join("specseal"));
        std::thread::sleep(Duration::from_millis(600));
        hits.store(0, Ordering::SeqCst); // 丢弃挂载批量

        std::fs::write(root.0.join("specseal").join("changes").join("note.md"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert!(hits.load(Ordering::SeqCst) >= 1, "specseal/ 下的写入必须通知");
    }

    #[test]
    fn a_paused_slot_mounts_nothing_until_resumed() {
        // 更新期间（可能改名规格文件夹）任何重挂都不得挂回，连较新的序号也一样——
        // 在途的 workspace-changed 或切回分页都会重挂。
        let root = TempRoot::new("pause");
        let mut slot = WatchSlot::new();
        assert!(slot.rearm(1, &root.0, Duration::from_millis(200), || {}).unwrap());
        slot.pause(3);
        assert!(!slot.rearm(2, &root.0, Duration::from_millis(200), || {}).unwrap(), "暂停前取号的重挂");
        assert!(!slot.rearm(4, &root.0, Duration::from_millis(200), || {}).unwrap(), "暂停期间取号的重挂");
        slot.resume();
        assert!(!slot.rearm(2, &root.0, Duration::from_millis(200), || {}).unwrap(), "恢复后陈旧序号照旧略过");
        let rebuilt = slot.rearm(5, &root.0, Duration::from_millis(200), || {}).unwrap();
        assert!(rebuilt, "恢复后必为重建：暂停已 drop 原监看");
    }

    // --- checkout 的技能档监看（remote-skill-delivery D8） ---

    /// claude 的 remote checkout：`.specseal.yaml`、一个技能档、一个原代码档。
    fn checkout(tag: &str) -> TempRoot {
        let root = TempRoot::new(tag);
        std::fs::write(
            root.0.join(".specseal.yaml"),
            "tools:\n  - claude\nremote:\n  url: https://team.example.test/api/specseal/v1/projects/acme\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.0.join(".claude").join("skills").join("specseal-apply")).unwrap();
        std::fs::write(root.0.join(".claude").join("skills").join("specseal-apply").join("SKILL.md"), "one\n").unwrap();
        std::fs::create_dir_all(root.0.join("src")).unwrap();
        std::fs::write(root.0.join("src").join("main.rs"), "fn main() {}\n").unwrap();
        root
    }

    /// 挂上 checkout 的监看，回传槽位与通知计数；挂载的自我通知已流完并归零。
    fn watched_checkout(root: &TempRoot) -> (WatchSlot, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        let mut slot = WatchSlot::new();
        let rebuilt = slot
            .rearm_checkout(1, &root.0, Duration::from_millis(200), move || {
                h.fetch_add(1, Ordering::SeqCst);
            })
            .expect("the checkout watch mounts");
        assert!(rebuilt, "首次必为重建");
        std::thread::sleep(Duration::from_millis(600));
        hits.store(0, Ordering::SeqCst);
        (slot, hits)
    }

    #[test]
    fn a_checkout_watch_notifies_for_a_skill_file_and_for_the_config() {
        let root = checkout("checkout-notify");
        let (_slot, hits) = watched_checkout(&root);

        std::fs::write(root.0.join(".claude").join("skills").join("specseal-apply").join("SKILL.md"), "two\n").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        // 去抖逐路径计时：一次写入可能拆成文件与文件夹两个路径、落在两轮（见上面的 coalesce 测试）。
        let n = hits.swap(0, Ordering::SeqCst);
        assert!((1..=2).contains(&n), "改动技能档要通知，而且去抖后至多两次，实际 {n}");

        let config = std::fs::read_to_string(root.0.join(".specseal.yaml")).unwrap();
        std::fs::write(root.0.join(".specseal.yaml"), format!("{config}# edited\n")).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        let n = hits.load(Ordering::SeqCst);
        assert!((1..=2).contains(&n), "改动 .specseal.yaml 要通知，而且去抖后至多两次，实际 {n}");
    }

    #[test]
    fn a_checkout_watch_does_not_notify_for_other_files() {
        let root = checkout("checkout-quiet");
        let (_slot, hits) = watched_checkout(&root);

        // 原代码、根目录的其他文件、技能目录旁边的文件：都不是探测会读的东西。
        std::fs::write(root.0.join("src").join("main.rs"), "fn main() { }\n").unwrap();
        std::fs::write(root.0.join("src").join("other.rs"), "// new\n").unwrap();
        std::fs::write(root.0.join("README.md"), "readme\n").unwrap();
        std::fs::write(root.0.join(".claude").join("settings.json"), "{}\n").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_checkout_watch_sees_a_skills_directory_that_appears_later() {
        let root = checkout("checkout-appears");
        std::fs::remove_dir_all(root.0.join(".claude")).unwrap();
        let (mut slot, hits) = watched_checkout(&root);

        std::fs::create_dir_all(root.0.join(".claude").join("skills")).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(hits.load(Ordering::SeqCst) >= 1, "工具文件夹的出现要通知");
        // 通知之后的那次重挂换成监看技能目录本身。
        assert!(slot.rearm_checkout(2, &root.0, Duration::from_millis(200), || {}).unwrap(), "目标改变须重建");
    }

    #[test]
    fn a_checkout_watch_notifies_when_a_whole_tool_folder_is_removed() {
        let root = checkout("checkout-removed");
        let (_slot, hits) = watched_checkout(&root);
        std::fs::remove_dir_all(root.0.join(".claude")).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(hits.load(Ordering::SeqCst) >= 1, "技能档全部不见了，要重新探测");
    }

    #[test]
    fn an_event_path_is_taken_relative_to_either_form_of_the_checkout_root() {
        // 事件回报的路径可能是解析后的形式，也可能是挂载时给的形式（Windows 上两者的前缀不同，
        // 连上层都不在的路径又无法范式）：两种根都要比得上。
        let resolved = PathBuf::from("/resolved/checkout");
        let as_given = PathBuf::from("/as-given/checkout");
        let roots = [resolved.clone(), as_given.clone()];
        let skill = Path::new(".claude").join("skills").join("specseal-apply");
        assert_eq!(relative_under(&roots, &resolved.join(&skill)), Some(skill.clone()));
        assert_eq!(relative_under(&roots, &as_given.join(&skill)), Some(skill));
        assert_eq!(relative_under(&roots, Path::new("/elsewhere/file")), None);
    }

    #[test]
    fn a_checkout_rearm_keeps_the_watcher_when_targets_are_unchanged_and_obeys_the_pause() {
        let root = checkout("checkout-rearm");
        let mut slot = WatchSlot::new();
        assert!(slot.rearm_checkout(1, &root.0, Duration::from_millis(200), || {}).unwrap());
        assert!(!slot.rearm_checkout(2, &root.0, Duration::from_millis(200), || {}).unwrap(), "目标不变沿用原监看");
        assert!(!slot.rearm_checkout(1, &root.0, Duration::from_millis(200), || {}).unwrap(), "陈旧序号略过");
        slot.pause(3);
        assert!(!slot.rearm_checkout(4, &root.0, Duration::from_millis(200), || {}).unwrap(), "暂停期间不挂");
        slot.resume();
        assert!(slot.rearm_checkout(5, &root.0, Duration::from_millis(200), || {}).unwrap(), "恢复后重建");
    }

    #[test]
    fn a_checkout_that_does_not_exist_mounts_nothing() {
        let root = TempRoot::new("checkout-gone");
        let gone = root.0.join("no-such-checkout");
        let mut slot = WatchSlot::new();
        assert!(slot.rearm_checkout(1, &gone, Duration::from_millis(200), || {}).is_err());
    }

    #[test]
    fn resolve_watch_target_walks_up_from_project_subdir() {
        // 仿真自建置输出目录（如 target/release）为 cwd 启动：起点在项目根
        // 之下，仍须向上探索出项目的 spec 目录。
        let root = TempRoot::new("resolve-subdir");
        let sub = root.0.join("target").join("release");
        std::fs::create_dir_all(&sub).unwrap();
        let target = resolve_watch_targets(&sub).expect("subdir inside a project must resolve")[0].clone();
        assert_eq!(target, root.0.join("specseal"));
    }

    #[test]
    fn resolve_watch_target_respects_custom_spec_dir_name() {
        let dir =
            std::env::temp_dir().join(format!("specseal-watch-customdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("myspecs")).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "spec_dir: myspecs\n").unwrap();
        let target = resolve_watch_targets(&dir).expect("project with custom spec dir must resolve")[0].clone();
        assert_eq!(
            target,
            dir.join("myspecs"),
            "watch target is the discovered spec dir, not a hardcoded name"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_watch_target_outside_any_project_errors() {
        let dir =
            std::env::temp_dir().join(format!("specseal-watch-noproj-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let err =
            resolve_watch_targets(&dir).expect_err("non-project start must be a loggable error");
        assert!(
            err.contains(&dir.display().to_string()),
            "error must name the start path for the log: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_watch_target_errors_without_panic() {
        // 监看目标（含其整条路径）不存在。
        let ghost = std::env::temp_dir().join("specseal-watch-ghost-root-nonexistent");
        let _ = std::fs::remove_dir_all(&ghost);
        let err = watch_targets(&[ghost.join("specseal")], Duration::from_millis(100), || {});
        assert!(
            err.is_err(),
            "missing target must be a loggable error, not a panic"
        );

        // 上层目录存在但监看目标本身不存在。
        let root =
            std::env::temp_dir().join(format!("specseal-watch-nospec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let err = watch_targets(&[root.join("specseal")], Duration::from_millis(100), || {});
        assert!(
            err.is_err(),
            "nonexistent target dir must be a loggable error"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
