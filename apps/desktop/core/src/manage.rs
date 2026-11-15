//! GUI 管理操作：change metadata 读取与 active change 删除。
//!
//! delete 是 desktop 层操作（引擎与 CLI 皆无 delete 动词）——仅作用于 active change
//! 目录、经路径安全检查、由 UI 以确认对话框把关。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use specseal_core::store::Store;

use crate::init_core_context;
use specseal_core::rank::neighbor_midpoint;

/// 每项目根一次的 git 身分缓存（design D1：identity 每根缓存）：完成路径高频取用，
/// 而 GUI 进程 spawn git 在部分环境极慢（杀毒扫描，实测单次 ~3 秒）——首次取得后
/// app 存续期内重用，身分变更需重启 app 才生效。持锁跨首次抓取：同根并发首抓只 spawn 一次。
static IDENTITY_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, Option<String>>>,
> = std::sync::OnceLock::new();

/// 任务写回全域锁（design D3：写入串行化（全域写锁））：写回 command 移至线程池后
/// 并发成为可能——读-改-写不串行化会互相覆盖（遗失更新）。写回入口整段持锁，
/// 依提交顺序落盘；读取路径不取锁维持快路径。
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取得写回锁（poisoned 时取回内值——锁只护顺序、无不变量需要放弃）。
fn write_guard() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// 取得（并缓存）指定根的 git 身分；供 app 启动／切根时背景预热与完成路径取用。
pub fn cached_git_identity(root: &Path) -> Option<String> {
    let cache = IDENTITY_CACHE.get_or_init(Default::default);
    let mut map = cache.lock().unwrap_or_else(|p| p.into_inner());
    map.entry(root.to_path_buf())
        .or_insert_with(|| specseal_host::context::git_identity(root))
        .clone()
}

/// 回传 change 的 metadata（camelCase：createdBy/createdWith/created）。无此 change 回 `None`。
pub fn change_meta_at(root: &Path, change: &str) -> Option<Value> {
    let ctx = crate::context_for_change(root, change)?;
    let change = ctx.store.find_change(change)?;
    Some(json!({
        "schema": change.meta.schema,
        "created": change.meta.created,
        "createdBy": change.meta.created_by,
        "createdWith": change.meta.created_with,
        "fromDiscussions": change.meta.from_discussions(),
        "startedAt": change.meta.started_at,
        "startedBy": change.meta.started_by,
        "startedWith": change.meta.started_with,
    }))
}

/// 删除一个 active change——走引擎 discard 全语意（force=false）：开工痕迹守门、
/// 来源讨论解链（清单空时状态回复）、touched 纪录清理。desktop 不提供 force 信道；
/// 解链明细不呈现，前端既有 refresh 自然反映讨论状态回复。
///
/// worktree 挂着时拒绝（design D3）：删除与封存、退回同属破坏性生命周期动词——
/// 它动的是主 checkout 的 change 目录存废，路由进 worktree 没有意义。
pub fn delete_change_at(root: &Path, change: &str) -> Result<(), String> {
    if !crate::query::is_safe_path_param(change) {
        return Err(format!("invalid change name: {change}"));
    }
    let ctx = init_core_context(root)
        .ok_or_else(|| format!("not a specseal project: {}", root.display()))?;
    // 守门（含 git spawn）在取写回锁之前完成：锁护文件写入，不护 git 观察面。
    crate::query::refuse_if_worktree_is_open(&ctx, change)?;
    let _guard = write_guard();
    specseal_core::discard::discard(&ctx.workspace, &ctx.store, change, false)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 退回提案中(desktop 直呼引擎动词):移除 in-progress 标记,仅零工作痕迹时
/// 放行。成功涵盖实际移除与未开工幂等——前端一律重载,卡片依派生归位。
/// 守门拒绝回传 [`revert_blocked_error`] 的结构化 JSON;其余错误为纯文本。
pub fn revert_change_to_proposed_at(root: &Path, change: &str) -> Result<(), String> {
    if !crate::query::is_safe_path_param(change) {
        return Err(format!("invalid change name: {change}"));
    }
    let ctx = init_core_context(root)
        .ok_or_else(|| format!("not a specseal project: {}", root.display()))?;
    // 守门（含 git spawn）在取写回锁之前完成，同 delete_change_at。
    crate::query::refuse_if_worktree_is_open(&ctx, change)?;
    let _guard = write_guard();
    specseal_core::inprogress::remove(&ctx.store, change)
        .map(|_| ())
        .map_err(|e| match e.downcast_ref::<specseal_core::inprogress::RevertBlocked>() {
            Some(b) => revert_blocked_error(b.checked_tasks, &b.touched_files),
            None => e.to_string(),
        })
}

/// 守门拒绝的结构化错误 JSON——本地与 remote 两个 bridge 共用的单一转译,
/// 前端守门对话框的唯一消费形状(kind/checkedTasks/touchedFiles)。
pub fn revert_blocked_error(checked_tasks: usize, touched_files: &[String]) -> String {
    json!({
        "kind": "revertBlocked",
        "checkedTasks": checked_tasks,
        "touchedFiles": touched_files,
    })
    .to_string()
}

/// 勾选/取消一个任务。`task` 双值域（与 CLI task 动词一致）：纯数字＝1-based
/// ordinal（仅计 checkbox 行）、tsk_ 前缀＝stable ID 寻址；其余值、寻址不中
/// 或无 tasks.md 回 `Err`。
///
/// done=true 走引擎的任务完成协作函数——与 CLI `task done` 相同的文件效果
/// （勾章、touched 记录、首次完成盖开工章；identity 沿 git 身分、agent 缺席）。
/// 与 CLI 唯一的差异：任务已完成时视为幂等成功（GUI toggle 语意下重复 done=true
/// 只可能来自竞态，不以错误打断用户），不写任何文件。
/// done=false（取消勾选）走引擎的反向动词 uncomplete——纯状态翻转，
/// 不盖章、不记 touched。
pub fn set_task_done_at(root: &Path, change: &str, task: &str, done: bool) -> Result<(), String> {
    if !crate::query::is_safe_path_param(change) {
        return Err(format!("invalid change name: {change}"));
    }
    let addr = if task.starts_with("tsk_") {
        specseal_core::tasks::TaskAddr::Stable(task.to_string())
    } else {
        let ordinal: usize = task
            .parse()
            .map_err(|_| format!("invalid task id: {task}"))?;
        specseal_core::tasks::TaskAddr::Ordinal(ordinal)
    };
    // 定根到该 change 的所在（design D1）：勾章、touched 记录、git 脏档归因与
    // 开工章全部落在同一份副本——内容在哪里，写入就在哪里。定根（含 git spawn）
    // 在取写回锁之前完成：锁护的是文件的读-改-写，不护 git 观察面。
    let ctx = crate::require_context_for_change(root, change)?;
    let _guard = write_guard();
    if done {
        // identity 键用调用端传入的项目根（与 app 启动预热同键）——定根后的
        // ctx.workspace.root 可能是 worktree 路径，身分其实是同一个 repo config。
        let identity = cached_git_identity(root);
        specseal_core::tasks::complete(
            &ctx.store,
            change,
            &addr,
            &specseal_core::tasks::CompleteAttribution {
                identity: identity.as_deref(),
                agent: None,
                repo: None,
            },
            specseal_core::tasks::TouchedCandidates::ProbeWorkspace(&ctx.workspace),
        )
        .map(|_| ()) // already → 幂等成功（引擎保证零文件效果）
        .map_err(|e| e.to_string())
    } else {
        specseal_core::tasks::uncomplete(&ctx.store, change, &addr)
            .map(|_| ()) // already → 幂等成功（引擎保证零文件效果）
            .map_err(|e| e.to_string())
    }
}

/// 调度分页的添加候选（add-change-plan-remote D9）：该 change 所在名册（与 [`set_depends_at`]
/// 同一个定根：有 worktree 映射为其副本）的其他作用中 change，依名称排序——分支后才在主
/// checkout 创建的 change 不在 worktree 副本的名册里，列出来只会被引擎拒绝。
pub fn depends_candidates_at(root: &Path, change: &str) -> Result<Vec<String>, String> {
    if !crate::query::is_safe_path_param(change) {
        return Err(format!("invalid change name: {change}"));
    }
    Ok(crate::require_context_for_change(root, change)?
        .store
        .list_changes()
        .into_iter()
        .map(|c| c.name)
        .filter(|name| name != change)
        .collect())
}

/// 声明（或 `remove` 时撤销）`on` 为 `change` 的前置（design D6）：守门与写入全在引擎
/// `plan::set_depends`——自依赖、不存在、已封存、成环一律拒绝且零写入，错误文本就是
/// 引擎消息。定根到该 change 的所在（有 worktree 映射写其副本），写入持全域写回锁。
/// 引擎的成环守门只看写入的那份 store：有 worktree 映射时，分支后主 checkout 才声明
/// 的反向边副本看不到，而看板同源视图（overlay）看得到——添加后以 overlay 复检一次，
/// 成环就撤销刚加的边、回引擎的成环消息（看板不会出现 planError）。
pub fn set_depends_at(root: &Path, change: &str, on: &[String], remove: bool) -> Result<(), String> {
    if !crate::query::is_safe_path_param(change) {
        return Err(format!("invalid change name: {change}"));
    }
    // facts 现取（含 git spawn）在取写回锁之前完成；定根与 overlay 用同一份 facts。
    let ctx = init_core_context(root)
        .ok_or_else(|| format!("not a specseal project: {}", root.display()))?;
    let facts = crate::facts_for(&ctx);
    let home = crate::home_store_for(&ctx, &facts, change);
    let _guard = write_guard();
    let before = home.find_change(change).map(|c| c.meta.depends_on()).unwrap_or_default();
    let write = specseal_core::plan::set_depends(&home, change, on, remove).map_err(|e| e.to_string())?;
    if !remove && write.changed {
        let overlaid = crate::query::overlay_store(&ctx, &facts);
        if let Err(cycle) = specseal_core::plan::check_cycle(&overlaid) {
            let added: Vec<String> = on.iter().filter(|n| !before.contains(n)).cloned().collect();
            specseal_core::plan::set_depends(&home, change, &added, true).map_err(|e| e.to_string())?;
            return Err(cycle.to_string());
        }
    }
    Ok(())
}

/// 批量设置全部任务的完成状态（desktop-task-interactions design D1：批量动词单指令双用）。
/// done=true＝全部标完成，done=false＝全部取消勾选；一次读档、一次写回。
/// 侧效沿单发勾选语意：done=true 且有翻转时 touched 记录一次（归于本次首个翻转的任务）、
/// 首次完成盖开工章；done=false 纯行编辑，无任何侧效。
/// 目标状态已达成时幂等成功、零文件效果。
pub fn set_all_tasks_at(root: &Path, change: &str, done: bool) -> Result<(), String> {
    if !crate::query::is_safe_path_param(change) {
        return Err(format!("invalid change name: {change}"));
    }
    let ctx = crate::require_context_for_change(root, change)?;
    let _guard = write_guard();
    let text = ctx
        .store
        .read_artifact(change, "tasks.md")
        .ok_or_else(|| format!("tasks.md not found for change: {change}"))?;
    let had_trailing_newline = text.ends_with('\n');
    // 逐行镜射引擎 tasks::parse 的 checkbox 判定——翻转集合与引擎所见一致
    // （dash／star 两种 bullet、[ ]/[x]/[X] 三态）。
    let mut first_flipped: Option<(usize, String)> = None;
    let mut ordinal = 0usize;
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let body = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* "));
            let Some(body) = body else { return line.to_string() };
            let cur = if body.starts_with("[ ] ") {
                false
            } else if body.starts_with("[x] ") || body.starts_with("[X] ") {
                true
            } else {
                return line.to_string();
            };
            ordinal += 1;
            if cur == done {
                return line.to_string();
            }
            if first_flipped.is_none() {
                first_flipped = Some((ordinal, body[4..].trim().to_string()));
            }
            let indent = &line[..line.len() - trimmed.len()];
            let bullet = &trimmed[..2];
            let mark = if done { "[x]" } else { "[ ]" };
            format!("{indent}{bullet}{mark}{}", &body[3..])
        })
        .collect();
    // 目标状态已达成→幂等成功、零文件效果。
    let Some((first_id, first_desc)) = first_flipped else { return Ok(()) };
    let mut out = lines.join("\n");
    if had_trailing_newline {
        out.push('\n');
    }
    ctx.store
        .write_artifact(change, "tasks.md", &out)
        .map_err(|e| e.to_string())?;
    if done {
        // 侧效沿单发完成语意（tasks::complete 同款）：未认领 dirty 档记一笔
        // 双信道记录——v1 touched（commit 技能的文件清单信道）＋ v2 EvidenceEntry
        // （evidence 查找面读的是这条），皆归于本次首个翻转任务；首次完成盖
        // 开工章（inprogress::add 幂等）。
        // identity 键同 set_task_done_at：用调用端项目根，与预热同键。
        let identity = cached_git_identity(root);
        let mut record = specseal_core::tasks::TouchedRecord::load(&ctx.store, change);
        record.change = change.to_string();
        let seen = record.all_files();
        let files: Vec<String> = specseal_core::tasks::git_changed_files(&ctx.workspace)
            .into_iter()
            .filter(|f| !seen.contains(f))
            .collect();
        if !files.is_empty() {
            record.touched.push(specseal_core::tasks::TouchedEntry {
                task_id: first_id.to_string(),
                task_desc: first_desc.clone(),
                files: files.clone(),
            });
            record.entries.push(specseal_core::tasks::EvidenceEntry {
                task_id: first_id.to_string(),
                task_desc: first_desc,
                actor: identity.clone(),
                repo: None,
                head_commit: specseal_core::tasks::head_commit(&ctx.workspace.root),
                touched_files: files,
                recorded_at: chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            });
            record.save(&ctx.store).map_err(|e| e.to_string())?;
        }
        specseal_core::inprogress::add(&ctx.store, change, identity.as_deref(), None, None)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 把第 `from` 个任务移到以第 `to` 个任务为锚的位置（皆 1-based、仅计 checkbox 行）。
/// 搬移＋重编号语意整段迁入 specseal-core（remote-verb-parity design 决策 4）——
/// 此处薄调用 core 同一引擎，桌面拖排与 server 端点行为逐比特一致。
pub fn move_task_at(
    root: &Path,
    change: &str,
    from: usize,
    to: usize,
    before: Option<bool>,
) -> Result<(), String> {
    if !crate::query::is_safe_path_param(change) {
        return Err(format!("invalid change name: {change}"));
    }
    let ctx = crate::require_context_for_change(root, change)?;
    let _guard = write_guard();
    specseal_core::tasks::move_task(&ctx.store, change, from, to, before)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 看板拖排写回（design D3/D5）：以邻居识别码表达落点，计中点 rank 写回被拖卡的
/// meta（变更）或 frontmatter（讨论）。目标栏内有缺 rank 卡时先依当前显示序整栏
/// 补章（等距键）再套用移动；已消失的邻居视为开放端（栏顶／栏底），不 panic。
pub fn reorder_card_at(
    root: &Path,
    kind: &str,
    id: &str,
    prev_id: Option<&str>,
    next_id: Option<&str>,
) -> Result<(), String> {
    if !crate::query::is_safe_path_param(id) {
        return Err(format!("invalid card id: {id}"));
    }
    for n in [prev_id, next_id].into_iter().flatten() {
        if !crate::query::is_safe_path_param(n) {
            return Err(format!("invalid neighbor id: {n}"));
        }
    }
    let ctx = init_core_context(root)
        .ok_or_else(|| format!("not a specseal project: {}", root.display()))?;
    match kind {
        // 变更卡：读走看板同源视图（overlay：主 roster ＋映射 change 的副本现值），
        // 写逐 change 解析落点——有映射写其 worktree 副本、无映射写主 checkout。
        // 整栏补章因此各回各家，不会把别的 change 的 rank 污染进被拖卡的 worktree
        // 分支；分支后才新建的 change 也在栏内。栏序、补章、中点与依赖检查是引擎
        // `plan::move_rank` 那一份（CLI 的 change rank 同一份），检查全在写入之前，
        // 被拒即零写入。讨论卡没有 worktree 映射，直走主 store。
        // facts 现取（含 git spawn）在取写回锁之前完成。
        "change" => {
            let facts = crate::facts_for(&ctx);
            let _guard = write_guard();
            let overlaid = crate::query::overlay_store(&ctx, &facts);
            let write = |name: &str, key: &str| {
                specseal_core::model::set_board_rank(&crate::home_store_for(&ctx, &facts, name), name, key)
            };
            specseal_core::plan::move_rank(&overlaid, &write, id, prev_id, next_id)
                .map_err(|e| e.to_string())
        }
        "discussion" => {
            let _guard = write_guard();
            reorder_discussion(&ctx.store, id, prev_id, next_id)
        }
        other => Err(format!("invalid card kind: {other}")),
    }
}

fn reorder_discussion(
    store: &dyn Store,
    id: &str,
    prev_id: Option<&str>,
    next_id: Option<&str>,
) -> Result<(), String> {
    let active = crate::discussions::board_sorted_active(store);
    if !active.iter().any(|(_, i)| i.slug == id) {
        return Err(format!("discussion not found: {id}"));
    }
    let ranks: std::collections::HashMap<&str, String> =
        if active.iter().any(|(r, _)| r.is_none()) {
            let keys = specseal_core::rank::spread(active.len());
            for ((_, i), key) in active.iter().zip(&keys) {
                specseal_core::discuss::set_board_rank(store, &i.slug, key)
                    .map_err(|e| e.to_string())?;
            }
            active.iter().map(|(_, i)| i.slug.as_str()).zip(keys).collect()
        } else {
            active
                .iter()
                .map(|(r, i)| (i.slug.as_str(), r.clone().expect("all ranked")))
                .collect()
        };
    let key = neighbor_midpoint(&ranks, prev_id, next_id);
    specseal_core::discuss::set_board_rank(store, id, &key).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 建含一个 active change 的暂存 fixture 项目。
    fn fixture_with_change(tag: &str, name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("specseal-manage-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("specseal").join("changes").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("proposal.md"), "## Why\ntest\n").unwrap();
        fs::write(
            dir.join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-07-05\ncreated_by: momo\ncreated_with: claude\n",
        )
        .unwrap();
        root
    }

    #[test]
    fn change_meta_returns_camel_case_fields_including_started_station() {
        let fx = crate::testfixture::FixtureRoot::new("m-meta");
        fx.add_change(
            "demo",
            "schema: spec-driven\ncreated: 2026-07-05\ncreated_by: momo\ncreated_with: claude\nstarted_at: 2026-07-06\nstarted_by: Worker <w@example.com>\nstarted_with: claude\n",
        );
        let meta = change_meta_at(fx.root(), "demo").expect("meta exists");
        assert_eq!(meta["created"], "2026-07-05");
        assert_eq!(meta["createdBy"], "momo");
        assert_eq!(meta["createdWith"], "claude");
        // 抽屉「谁于何时开工」的数据源：started 站以 camelCase 带出。
        assert_eq!(meta["startedAt"], "2026-07-06");
        assert_eq!(meta["startedBy"], "Worker <w@example.com>");
        assert_eq!(meta["startedWith"], "claude");
    }

    #[test]
    fn change_meta_without_started_fields_yields_nulls() {
        let fx = crate::testfixture::FixtureRoot::new("m-meta-old");
        fx.add_change("demo", "schema: spec-driven\ncreated: 2026-07-05\n");
        let meta = change_meta_at(fx.root(), "demo").expect("meta exists");
        assert!(meta.get("startedAt").is_some(), "key present");
        assert!(meta["startedAt"].is_null());
        assert!(meta["startedBy"].is_null());
        assert!(meta["startedWith"].is_null());
    }

    #[test]
    fn change_meta_exposes_from_discussions_as_array() {
        // 详情抽屉「来源讨论」的数据源：多值化的 fromDiscussions 数组（依 meta 顺序），
        // 无来源讨论时为空数组；不再输出旧单值键 fromDiscussion。
        let fx = crate::testfixture::FixtureRoot::new("m-meta-fromdisc");
        fx.add_change(
            "multi",
            "schema: spec-driven\ncreated: 2026-07-05\nfrom_discussion: alpha-search, beta-cache\n",
        );
        fx.add_change("plain", "schema: spec-driven\ncreated: 2026-07-05\n");
        let m = change_meta_at(fx.root(), "multi").expect("meta exists");
        assert_eq!(m["fromDiscussions"], json!(["alpha-search", "beta-cache"]));
        assert!(m.get("fromDiscussion").is_none(), "old single-value key gone");
        let p = change_meta_at(fx.root(), "plain").expect("meta exists");
        assert_eq!(p["fromDiscussions"], json!([]));
    }

    #[test]
    fn change_meta_comes_from_the_worktree_copy() {
        // spec worktree-overlay「desktop 看板的 worktree 呈现」：抽屉的 metadata
        // 字段（创建与开工信息）对有映射的 change 须读 worktree 副本——开工章是
        // 在 worktree 内盖的，读主 checkout 会显示成从未开工。
        let fx = crate::testfixture::FixtureRoot::new("m-meta-wt");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        let wt = fx.attach_worktree("add-auth");
        fs::write(
            wt.change_dir("add-auth")
                .join(".meta.yaml"),
            "schema: spec-driven\ncreated: 2026-07-05\nstarted_at: 2026-07-06\nstarted_by: Worker <w@example.com>\nstarted_with: claude\n",
        )
        .unwrap();

        let meta = change_meta_at(fx.root(), "add-auth").expect("meta exists");
        assert_eq!(meta["startedAt"], "2026-07-06", "开工章须读 worktree 副本: {meta}");
        assert_eq!(meta["startedBy"], "Worker <w@example.com>");
        assert_eq!(meta["startedWith"], "claude");
    }

    #[test]
    fn change_meta_unknown_change_is_none() {
        let fx = crate::testfixture::FixtureRoot::new("m-meta-unknown");
        fx.add_change("demo", "schema: spec-driven\n");
        assert!(change_meta_at(fx.root(), "no-such-change-xyz").is_none());
    }

    // --- 退回提案中:引擎动词直呼与守门错误的共用转译 ---

    const STARTED_META: &str = "schema: spec-driven\ncreated: 2026-07-05\nstarted_at: 2026-07-06\nstarted_by: Worker <w@example.com>\nstarted_with: claude\n";

    #[test]
    fn revert_zero_trace_change_removes_started_lines_verbatim() {
        let fx = crate::testfixture::FixtureRoot::new("m-revert-ok");
        fx.add_change("demo", STARTED_META);
        // add_change 缺省 tasks.md 含一个已勾任务——覆写为零勾选(零痕迹)。
        fx.write("specseal/changes/demo/tasks.md", "## 1. Group\n\n- [ ] 1.1 First task\n");
        revert_change_to_proposed_at(fx.root(), "demo").expect("zero-trace revert succeeds");
        let meta = fs::read_to_string(
            fx.root().join("specseal/changes/demo/.meta.yaml"),
        )
        .unwrap();
        assert_eq!(
            meta, "schema: spec-driven\ncreated: 2026-07-05\n",
            "started_* lines removed, every other line byte-identical"
        );
    }

    #[test]
    fn revert_is_refused_while_the_change_has_a_worktree() {
        // spec worktree-overlay「worktree 挂着时的 desktop 动词防护」：退回提案中
        // 与封存同一条红线——工作在 worktree 副本里，主 checkout 不该擅自退回。
        let fx = crate::testfixture::FixtureRoot::new("m-revert-wt");
        fx.add_change("demo", STARTED_META);
        fx.write("specseal/changes/demo/tasks.md", "## 1. Group\n\n- [ ] 1.1 First task\n");
        fx.write(".specseal.yaml", "tools:\n  - claude\n");
        fx.write("specseal/config.yaml", "schema: spec-driven\nworktree: true\n");
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(fx.root())
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.test")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.test")
                .output()
                .expect("run git");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["add", "-A"]);
        git(&["commit", "-qm", "seed"]);
        git(&["worktree", "add", "-q", "-b", "specseal/demo", fx.root().join("wt").to_str().unwrap()]);

        let err = revert_change_to_proposed_at(fx.root(), "demo").expect_err("必须拒绝");
        assert!(err.contains("worktree-merge"), "须指出收尾方式: {err}");
        let meta = fs::read_to_string(fx.root().join("specseal/changes/demo/.meta.yaml")).unwrap();
        assert!(meta.contains("started_at"), "拒绝时开工戳记不得被移除: {meta}");
    }

    #[test]
    fn revert_on_unstarted_change_is_idempotent_success() {
        let fx = crate::testfixture::FixtureRoot::new("m-revert-idem");
        fx.add_change("demo", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.write("specseal/changes/demo/tasks.md", "## 1. Group\n\n- [ ] 1.1 First task\n");
        revert_change_to_proposed_at(fx.root(), "demo").expect("idempotent success");
    }

    #[test]
    fn revert_blocked_returns_the_shared_structured_error_json() {
        let fx = crate::testfixture::FixtureRoot::new("m-revert-blocked");
        fx.add_change("demo", STARTED_META); // 缺省 tasks.md 含 1 个已勾任务
        fx.write(
            ".specseal/touched/demo.json",
            r#"{"change":"demo","touched":[{"task_id":"2","task_desc":"1.2 Second task","files":["src/a.rs"]}]}"#,
        );
        let err = revert_change_to_proposed_at(fx.root(), "demo")
            .expect_err("work traces must block the revert");
        let v: Value = serde_json::from_str(&err).expect("structured JSON error");
        assert_eq!(v["kind"], "revertBlocked");
        assert_eq!(v["checkedTasks"], 1);
        assert_eq!(v["touchedFiles"], json!(["src/a.rs"]));
        // remote bridge 走同一转译函数——形状由这条断言钉住。
        assert_eq!(err, revert_blocked_error(1, &["src/a.rs".to_string()]));
        let meta = fs::read_to_string(
            fx.root().join("specseal/changes/demo/.meta.yaml"),
        )
        .unwrap();
        assert_eq!(meta, STARTED_META, "a refusal must not touch the meta");
    }

    #[test]
    fn delete_change_removes_active_change() {
        // 无痕迹 fixture（无 started_at、零勾选）——delete 走 discard 全语意后
        // 守门放行的基准案例。
        let root = fixture_with_change("del", "doomed-change");
        fs::write(
            root.join("specseal").join("changes").join("doomed-change").join("tasks.md"),
            "- [ ] 1.1 open\n",
        )
        .unwrap();
        let ctx = crate::init_core_context(&root).unwrap();
        assert!(ctx.store.change_exists("doomed-change"));
        delete_change_at(&root, "doomed-change").expect("delete ok");
        let ctx2 = crate::init_core_context(&root).unwrap();
        assert!(!ctx2.store.change_exists("doomed-change"));
        let _ = fs::remove_dir_all(&root);
    }

    // --- 删除走 discard 全语意（spec desktop-app「桌面删除变更走 discard 全语意」）---

    const PROMOTED_D1: &str = "---\ntopic: d1\nslug: d1\nstatus: promoted\npromoted_to: cut\ncreated: 2026-07-01\n---\n\n## Conclusion\n\n**Decision**: x\n";

    #[test]
    fn delete_promoted_change_unlinks_source_discussion_and_clears_touched() {
        // spec scenario「删除转出 change 连带解链来源讨论」：目录消失、touched
        // 清除；来源讨论 promoted_to 移除该名，清单空时状态回复 concluded。
        let fx = crate::testfixture::FixtureRoot::new("del-unlink");
        fx.add_change("cut", "schema: spec-driven\ncreated: 2026-07-05\nfrom_discussion: d1\n");
        // add_change 缺省 tasks.md 含一个已勾任务——覆写为零痕迹。
        fx.write("specseal/changes/cut/tasks.md", "- [ ] 1.1 open\n");
        fx.write("specseal/discussions/d1.md", PROMOTED_D1);
        fx.write(".specseal/touched/cut.json", "{\"change\":\"cut\",\"touched\":[]}");

        delete_change_at(fx.root(), "cut").expect("trace-free delete succeeds");

        assert!(!fx.root().join("specseal/changes/cut").exists(), "change directory gone");
        assert!(
            !fx.root().join(".specseal/touched/cut.json").exists(),
            "touched record cleared"
        );
        let doc = fs::read_to_string(fx.root().join("specseal/discussions/d1.md")).unwrap();
        assert!(!doc.contains("promoted_to"), "promoted_to entry removed: {doc}");
        assert!(
            doc.contains("status: concluded\n"),
            "status reverts when the list empties: {doc}"
        );
    }

    #[test]
    fn delete_started_change_is_refused_with_zero_file_effects() {
        // spec scenario「有开工痕迹的本地删除被拒」：meta 含 started_at → Err，
        // specseal/ 下任何文件逐比特不变（含来源讨论不解链）。
        let fx = crate::testfixture::FixtureRoot::new("del-refused");
        fx.add_change(
            "cut",
            "schema: spec-driven\ncreated: 2026-07-05\nstarted_at: 2026-07-06\nfrom_discussion: d1\n",
        );
        fx.write("specseal/changes/cut/tasks.md", "- [ ] 1.1 open\n");
        fx.write("specseal/discussions/d1.md", PROMOTED_D1);
        let meta_path = fx.root().join("specseal/changes/cut/.meta.yaml");
        let meta_before = fs::read_to_string(&meta_path).unwrap();

        delete_change_at(fx.root(), "cut").expect_err("started change must refuse delete");

        assert!(fx.root().join("specseal/changes/cut").exists(), "change directory preserved");
        assert_eq!(fs::read_to_string(&meta_path).unwrap(), meta_before, "meta byte-identical");
        assert_eq!(
            fs::read_to_string(fx.root().join("specseal/discussions/d1.md")).unwrap(),
            PROMOTED_D1,
            "discussion untouched — no unlink on a refused delete"
        );
    }

    // --- 写入面路由（spec worktree-overlay「worktree 挂着时的 desktop 动词防护」
    // 的粒度写入动词：文件效果与侧效落在 worktree 副本）---

    #[test]
    fn set_task_done_writes_into_the_worktree_copy() {
        // Scenario「任务勾选写入 worktree」：勾章落在副本的 tasks.md，touched 记录
        // 同落副本（归因扫的是副本的脏档），主 checkout 的 tasks.md 比特级不变。
        let fx = crate::testfixture::FixtureRoot::new("m-task-wt");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.write("specseal/changes/add-auth/tasks.md", "## 1. Group\n\n- [ ] 1.1 first\n");
        let wt = fx.attach_worktree("add-auth");
        let main_tasks = fx.root().join("specseal/changes/add-auth/tasks.md");
        let main_before = fs::read_to_string(&main_tasks).unwrap();
        // 副本内的未认领脏档——勾选的归因来源。
        fs::write(wt.path().join("src.rs"), "fn implemented_in_the_worktree() {}\n").unwrap();

        set_task_done_at(fx.root(), "add-auth", "1", true).expect("勾选成功");

        let wt_change = wt.change_dir("add-auth");
        let wt_tasks = fs::read_to_string(wt_change.join("tasks.md")).unwrap();
        assert!(wt_tasks.contains("- [x] 1.1 first"), "勾章须落在 worktree 副本: {wt_tasks}");
        assert_eq!(
            fs::read_to_string(&main_tasks).unwrap(),
            main_before,
            "主 checkout 的 tasks.md 比特级不变"
        );
        let record = fs::read_to_string(wt_change.join(".evidence.json"))
            .expect("touched 记录落在 worktree 副本");
        assert!(record.contains("src.rs"), "归因扫的是副本的脏档: {record}");
        assert!(
            !fx.root().join("specseal/changes/add-auth/.evidence.json").exists(),
            "主 checkout 不留记录"
        );
        // 首次完成的开工章同样落在副本。
        let wt_meta = fs::read_to_string(wt_change.join(".meta.yaml")).unwrap();
        assert!(wt_meta.contains("started_at:"), "开工章须落在副本: {wt_meta}");
        assert!(
            !fs::read_to_string(fx.root().join("specseal/changes/add-auth/.meta.yaml"))
                .unwrap()
                .contains("started_at:"),
            "主 checkout 的 metadata 不被写入"
        );
    }

    #[test]
    fn bulk_check_and_task_move_write_into_the_worktree_copy() {
        // 粒度写入动词同一落点：全部勾选与任务拖排也写副本的 tasks.md
        // （全勾自行写回、拖排走引擎，两条路径都要跟着定根）。
        let fx = crate::testfixture::FixtureRoot::new("m-bulk-wt");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.write(
            "specseal/changes/add-auth/tasks.md",
            "## 1. Group\n\n- [ ] 1.1 first\n- [ ] 1.2 second\n",
        );
        let wt = fx.attach_worktree("add-auth");
        let main_tasks = fx.root().join("specseal/changes/add-auth/tasks.md");
        let main_before = fs::read_to_string(&main_tasks).unwrap();
        let wt_tasks = wt.change_dir("add-auth")
            .join("tasks.md");

        set_all_tasks_at(fx.root(), "add-auth", true).expect("全勾成功");
        let after_bulk = fs::read_to_string(&wt_tasks).unwrap();
        assert!(
            after_bulk.contains("- [x] 1.1 first") && after_bulk.contains("- [x] 1.2 second"),
            "全勾须落在 worktree 副本: {after_bulk}"
        );
        assert_eq!(fs::read_to_string(&main_tasks).unwrap(), main_before, "主 checkout 不动");

        move_task_at(fx.root(), "add-auth", 2, 1, None).expect("拖排成功");
        let after_move = fs::read_to_string(&wt_tasks).unwrap();
        assert!(after_move.contains("- [x] 1.1 second"), "拖排须落在副本: {after_move}");
        assert_eq!(fs::read_to_string(&main_tasks).unwrap(), main_before, "主 checkout 仍不动");
    }

    #[test]
    fn bulk_check_records_v2_evidence_like_a_single_completion() {
        // 批量勾选沿单发完成语意：除了 v1 touched 信道，也要落 v2 EvidenceEntry
        // ——只写 v1 的记录在新的 evidence 查找面（server 端点、封存 trace）会被
        // 读成空集合。
        let fx = crate::testfixture::FixtureRoot::new("m-bulk-evidence");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.write(
            "specseal/changes/add-auth/tasks.md",
            "## 1. Group\n\n- [ ] 1.1 first\n- [ ] 1.2 second\n",
        );
        git_with_identity(fx.root(), "Bulk Tester", "bulk@example.test");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(fx.root())
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        git(&["add", "-A"]);
        git(&["commit", "-qm", "seed"]);
        fx.write("src/app.rs", "fn main() {}\n");

        set_all_tasks_at(fx.root(), "add-auth", true).expect("全勾成功");

        let store = specseal_fs::FsStore::new(fx.root(), "specseal");
        let rec = specseal_core::tasks::TouchedRecord::load(&store, "add-auth");
        assert_eq!(rec.touched.len(), 1, "v1 file-list channel keeps its entry");
        assert_eq!(rec.entries.len(), 1, "the v2 evidence entry lands too: {rec:?}");
        let e = &rec.entries[0];
        assert!(e.touched_files.contains(&"src/app.rs".to_string()), "{e:?}");
        assert_eq!(e.actor.as_deref(), Some("Bulk Tester <bulk@example.test>"));
        assert!(e.head_commit.is_some(), "a committed checkout records its HEAD");
        assert!(!e.recorded_at.is_empty());
    }

    #[test]
    fn discarding_the_review_ticket_targets_the_worktree_copy() {
        // 放弃审查工单同属粒度写入动词：删的是副本的工单，主 checkout 的同名档不动。
        let fx = crate::testfixture::FixtureRoot::new("m-discard-wt");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.write("specseal/changes/add-auth/review.md", "# Review — 主 checkout 的旧工单\n");
        let wt = fx.attach_worktree("add-auth");
        let wt_ticket = wt.change_dir("add-auth")
            .join("review.md");

        crate::verbs::discard_review_at(fx.root(), "add-auth").expect("放弃工单成功");

        assert!(!wt_ticket.exists(), "副本的工单须被删除");
        assert!(
            fx.root().join("specseal/changes/add-auth/review.md").is_file(),
            "主 checkout 的工单不受影响"
        );
    }

    #[test]
    fn reorder_card_writes_the_rank_into_the_worktree_copy() {
        // Scenario「卡片拖排位置保持」：rank 写入 worktree 副本的 change metadata，
        // 与看板读取（走 overlay）同源——写主 checkout 会在下次刷新被覆盖回原位。
        let fx = crate::testfixture::FixtureRoot::new("m-rank-wt");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        let wt = fx.attach_worktree("add-auth");

        reorder_card_at(fx.root(), "change", "add-auth", None, None).expect("拖排成功");

        let wt_meta = fs::read_to_string(
            wt.change_dir("add-auth")
                .join(".meta.yaml"),
        )
        .unwrap();
        assert!(wt_meta.contains("board_rank:"), "rank 须写入 worktree 副本: {wt_meta}");
        assert!(
            !fs::read_to_string(fx.root().join("specseal/changes/add-auth/.meta.yaml"))
                .unwrap()
                .contains("board_rank:"),
            "主 checkout 的 metadata 不被写入"
        );
    }

    #[test]
    fn column_restamp_writes_each_change_into_its_own_home() {
        // 审查 finding（Round 1 CRITICAL）：拖排的整栏补章不得整栏写进被拖卡的
        // worktree 副本。读取面走看板同源视图（overlay：主 roster ＋映射值），
        // 写入逐 change 解析落点——有映射写副本、无映射写主 checkout；分支后
        // 才在主 checkout 新建的 change 也要在栏内（否则邻居定位与补章都漏掉它）。
        let fx = crate::testfixture::FixtureRoot::new("m-rank-column-wt");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.add_change("beta", "schema: spec-driven\ncreated: 2026-07-05\n");
        let wt = fx.attach_worktree("add-auth");
        // gamma 只存在于主 checkout（分支后新建）——worktree 快照里没有它。
        fx.add_change("gamma", "schema: spec-driven\ncreated: 2026-07-05\n");

        reorder_card_at(fx.root(), "change", "add-auth", None, None).expect("拖排成功");

        let meta = |p: &std::path::Path| fs::read_to_string(p).unwrap();
        let main_meta =
            |name: &str| meta(&fx.root().join(format!("specseal/changes/{name}/.meta.yaml")));
        let wt_meta = |name: &str| {
            meta(&wt.change_dir(name)
                .join(".meta.yaml"))
        };

        assert!(wt_meta("add-auth").contains("board_rank:"), "被拖卡写进 worktree 副本");
        assert!(
            !main_meta("add-auth").contains("board_rank:"),
            "被拖卡不写主 checkout"
        );
        assert!(main_meta("beta").contains("board_rank:"), "无映射同栏卡补章落在主 checkout");
        assert!(!wt_meta("beta").contains("board_rank:"), "无映射卡不得污染 worktree 副本");
        assert!(
            main_meta("gamma").contains("board_rank:"),
            "主 checkout 新建的卡也在栏内、补章落在主 checkout"
        );
    }

    #[test]
    fn delete_is_refused_while_the_change_has_a_worktree() {
        // Scenario「删除被挡」：删除是破坏性生命周期动词，与封存、退回同一级——
        // 拒绝并提示先收尾，两份 change 目录均不变。
        let fx = crate::testfixture::FixtureRoot::new("m-del-wt");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        // 零痕迹：守门之外的既有前置都会放行，拒绝只可能来自 worktree 守门。
        fx.write("specseal/changes/add-auth/tasks.md", "- [ ] 1.1 open\n");
        let wt = fx.attach_worktree("add-auth");

        let err = delete_change_at(fx.root(), "add-auth").expect_err("有 worktree 映射时必须拒绝");

        assert!(err.contains("worktree-merge"), "须指出收尾方式: {err}");
        assert!(err.contains("add-auth"), "须指名 change: {err}");
        assert!(
            fx.root().join("specseal/changes/add-auth").is_dir(),
            "主 checkout 的 change 目录不变"
        );
        assert!(
            wt.change_dir("add-auth").is_dir(),
            "worktree 副本的 change 目录不变"
        );
    }

    #[test]
    fn writes_land_in_the_main_checkout_when_the_policy_is_off() {
        // design D4 红线：worktree 政策关闭 → facts 为空 → 写入面全部回到主
        // checkout、守门退场，与 worktree 功能出现前完全相同。
        let fx = crate::testfixture::FixtureRoot::new("m-policy-off");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.write("specseal/changes/add-auth/tasks.md", "## 1. Group\n\n- [ ] 1.1 first\n");
        let wt = fx.attach_worktree("add-auth");
        fx.write("specseal/config.yaml", "schema: spec-driven\nworktree: false\n");

        set_task_done_at(fx.root(), "add-auth", "1", true).expect("勾选成功");

        let main_tasks =
            fs::read_to_string(fx.root().join("specseal/changes/add-auth/tasks.md")).unwrap();
        assert!(main_tasks.contains("- [x] 1.1 first"), "勾章落在主 checkout: {main_tasks}");
        let wt_tasks = fs::read_to_string(
            wt.change_dir("add-auth").join("tasks.md"),
        )
        .unwrap();
        assert!(wt_tasks.contains("- [ ] 1.1 first"), "副本不被写入: {wt_tasks}");

        // 删除守门同样退场——这次挡下来的是既有的开工痕迹，不是 worktree。
        let err = delete_change_at(fx.root(), "add-auth").expect_err("已有痕迹，删除仍被挡");
        assert!(!err.contains("worktree-merge"), "worktree 守门须已退场: {err}");
    }

    fn fixture_with_tasks(tag: &str) -> PathBuf {
        let root = fixture_with_change(tag, "task-change");
        let dir = root.join("specseal").join("changes").join("task-change");
        fs::write(
            dir.join("tasks.md"),
            "## 1. Group A\n\n- [ ] 1.1 first\n- [x] 1.2 second\n\n## 2. Group B\n\n- [ ] 2.1 third\n",
        )
        .unwrap();
        root
    }

    fn read_tasks(root: &PathBuf) -> String {
        fs::read_to_string(
            root.join("specseal").join("changes").join("task-change").join("tasks.md"),
        )
        .unwrap()
    }

    #[test]
    fn set_task_done_toggles_only_the_target_line() {
        let root = fixture_with_tasks("toggle");
        set_task_done_at(&root, "task-change", "1", true).expect("check first");
        set_task_done_at(&root, "task-change", "2", false).expect("uncheck second");
        let text = read_tasks(&root);
        assert!(text.contains("- [x] 1.1 first"));
        assert!(text.contains("- [ ] 1.2 second"));
        assert!(text.contains("- [ ] 2.1 third"), "untouched line intact");
        assert!(text.contains("## 1. Group A"), "group headings intact");
        assert!(set_task_done_at(&root, "task-change", "99", true).is_err(), "out of range errors");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uncheck_star_bullet_task_flips_the_line() {
        // 取消勾选 delegate 引擎后，`* ` bullet 与 `- ` 同样正确翻转
        // （旧桌面 regex 只认 `- `，此案例于 delegate 前红灯）。
        let root = fixture_with_tasks_md(
            "star-uncheck",
            "## 1. Group\n\n- [x] 1.1 first\n* [x] 1.2 star\n",
        );
        set_task_done_at(&root, "task-change", "2", false).expect("uncheck star-bullet task");
        let text = read_tasks(&root);
        assert!(text.contains("* [ ] 1.2 star"), "star bullet must flip back to open: {text}");
        assert!(text.contains("- [x] 1.1 first"), "other line untouched: {text}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_task_reorders_checkbox_lines_only() {
        let root = fixture_with_tasks("move");
        // 把第 3 个任务移到第 1 位——落入群组 1 并依新顺序重编号。
        move_task_at(&root, "task-change", 3, 1, None).expect("move up");
        let text = read_tasks(&root);
        let tasks: Vec<&str> = text.lines().filter(|l| l.trim_start().starts_with("- [")).collect();
        assert_eq!(tasks[0], "- [ ] 1.1 third");
        assert_eq!(tasks[1], "- [ ] 1.2 first");
        assert_eq!(tasks[2], "- [x] 1.3 second");
        // 群组标题数不变
        assert_eq!(text.matches("## ").count(), 2);
        assert!(move_task_at(&root, "task-change", 0, 1, None).is_err(), "0 index errors");
        let _ = fs::remove_dir_all(&root);
    }

    fn fixture_with_tasks_md(tag: &str, tasks: &str) -> PathBuf {
        let root = fixture_with_change(tag, "task-change");
        let dir = root.join("specseal").join("changes").join("task-change");
        fs::write(dir.join("tasks.md"), tasks).unwrap();
        root
    }

    fn task_lines(root: &PathBuf) -> Vec<String> {
        read_tasks(root)
            .lines()
            .filter(|l| l.trim_start().starts_with("- ["))
            .map(|l| l.to_string())
            .collect()
    }

    #[test]
    fn move_within_group_renumbers_prefixes_per_spec_example() {
        // spec Example「组内移动重编号」：把 1.1 甲拖到末位 → 乙丙甲，前缀重写 1.1/1.2/1.3。
        let root = fixture_with_tasks_md(
            "renum-within",
            "## 1. 群组\n\n- [ ] 1.1 甲\n- [x] 1.2 乙\n- [ ] 1.3 丙\n",
        );
        move_task_at(&root, "task-change", 1, 3, None).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [x] 1.1 乙", "- [ ] 1.2 丙", "- [ ] 1.3 甲"],
            "prefixes must follow the new order"
        );
        assert!(read_tasks(&root).contains("## 1. 群组"), "group heading untouched");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_across_groups_takes_the_new_groups_numbering() {
        // 把群组 1 的乙拖到群组 2 的丙之后 → 乙取得新群组编号 2.2，丁后移 2.3。
        let root = fixture_with_tasks_md(
            "renum-cross",
            "## 1. 前段\n\n说明文本原样保留。\n\n- [ ] 1.1 甲\n- [ ] 1.2 乙\n\n## 2. 后段\n\n- [ ] 2.1 丙\n- [ ] 2.2 丁\n",
        );
        move_task_at(&root, "task-change", 2, 3, None).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [ ] 1.1 甲", "- [ ] 2.1 丙", "- [ ] 2.2 乙", "- [ ] 2.3 丁"]
        );
        let text = read_tasks(&root);
        assert!(text.contains("说明文本原样保留。"), "prose lines byte-identical");
        assert!(text.contains("## 1. 前段") && text.contains("## 2. 后段"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tasks_without_numeric_prefix_keep_their_text_verbatim() {
        let root = fixture_with_tasks_md(
            "renum-noprefix",
            "## 1. 群组\n\n- [ ] 1.1 甲\n- [ ] 补充说明不带编号\n- [ ] 1.2 乙\n",
        );
        move_task_at(&root, "task-change", 3, 1, None).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [ ] 1.1 乙", "- [ ] 1.2 甲", "- [ ] 补充说明不带编号"],
            "unprefixed task text must stay untouched while others renumber"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn groups_without_numeric_heading_are_not_renumbered() {
        let root = fixture_with_tasks_md(
            "renum-unnumbered",
            "## 准备\n\n- [ ] 1.1 甲\n- [ ] 1.2 乙\n",
        );
        move_task_at(&root, "task-change", 1, 2, None).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [ ] 1.2 乙", "- [ ] 1.1 甲"],
            "a heading without a numeric prefix must leave its tasks' numbers alone"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn before_true_crosses_the_heading_and_becomes_group_head() {
        // spec Example「标题落点成组首」：把 1.2 乙拖到「## 2. 后段」标题上——
        // 前端解析为（to=组首任务 ordinal, before=true）→ 乙插于丙行之前、
        // 跨过标题成为群组 2 第一个任务。
        let root = fixture_with_tasks_md(
            "side-head",
            "## 1. 前段\n\n- [ ] 1.1 甲\n- [ ] 1.2 乙\n\n## 2. 后段\n\n- [ ] 2.1 丙\n- [ ] 2.2 丁\n",
        );
        move_task_at(&root, "task-change", 2, 3, Some(true)).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [ ] 1.1 甲", "- [ ] 2.1 乙", "- [ ] 2.2 丙", "- [ ] 2.3 丁"],
            "before=true must insert ahead of the anchor line, across the heading"
        );
        let text = read_tasks(&root);
        let g2 = text.split("## 2. 后段").nth(1).unwrap();
        assert!(g2.contains("乙"), "乙 must live under group 2: {text}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn before_false_explicitly_inserts_after_the_anchor() {
        // 明确侧别覆盖方向推断：向上移动＋before=false → 落在锚任务之后。
        let root = fixture_with_tasks_md(
            "side-after",
            "## 1. 群组\n\n- [ ] 1.1 甲\n- [ ] 1.2 乙\n- [ ] 1.3 丙\n",
        );
        move_task_at(&root, "task-change", 3, 1, Some(false)).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [ ] 1.1 甲", "- [ ] 1.2 丙", "- [ ] 1.3 乙"],
            "before=false anchors after task 1 even on an upward move"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn side_parameter_keeps_out_of_range_errors_and_none_inference() {
        let root = fixture_with_tasks_md(
            "side-oob",
            "## 1. 前段\n\n- [ ] 1.1 甲\n- [x] 1.2 乙\n- [ ] 1.3 丙\n\n## 2. 后段\n\n- [ ] 2.1 丁\n",
        );
        let before_text = read_tasks(&root);
        assert!(move_task_at(&root, "task-change", 9, 1, Some(true)).is_err());
        assert!(move_task_at(&root, "task-change", 0, 2, Some(false)).is_err());
        assert_eq!(read_tasks(&root), before_text, "failed side moves must not rewrite");
        // None 维持方向推断：向下拖到群组末位仍留在原群组（既有行为）。
        move_task_at(&root, "task-change", 1, 3, None).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [x] 1.1 乙", "- [ ] 1.2 丙", "- [ ] 1.3 甲", "- [ ] 2.1 丁"]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn downward_move_to_group_end_stays_in_the_origin_group() {
        // 真实窗口抓到的边界缺陷：向下拖到群组末位时，「插在下一个 checkbox 前」
        // 会把任务吞进下一群组——向下移动必须落在目标 checkbox 之后（留在原群组）。
        let root = fixture_with_tasks_md(
            "renum-boundary",
            "## 1. 前段\n\n- [ ] 1.1 甲\n- [x] 1.2 乙\n- [ ] 1.3 丙\n\n## 2. 后段\n\n- [ ] 2.1 丁\n- [ ] 2.2 戊\n",
        );
        move_task_at(&root, "task-change", 1, 3, None).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [x] 1.1 乙", "- [ ] 1.2 丙", "- [ ] 1.3 甲", "- [ ] 2.1 丁", "- [ ] 2.2 戊"],
            "a downward move onto the last task of a group must not leak into the next group"
        );
        let text = read_tasks(&root);
        let g2 = text.split("## 2. 后段").nth(1).unwrap();
        assert!(!g2.contains("甲"), "甲 must stay under group 1: {text}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sub_versioned_prefixes_are_never_mangled() {
        // sharp-edge：`1.2.3` 的「1.2」后面是「.」不是空白——比对要求前缀后必须
        // 是空白，否则改写会把子版号绞成「2.1.3」这种残骸。
        let root = fixture_with_tasks_md(
            "renum-subver",
            "## 1. 群组\n\n- [ ] 1.1 甲\n- [ ] 1.2.3 子版号文本\n",
        );
        move_task_at(&root, "task-change", 2, 1, None).expect("move ok");
        // 子版号列逐字符保留；甲成为组内第 2 个 checkbox，依「群组编号.组内序」重写 1.2。
        assert_eq!(
            task_lines(&root),
            vec!["- [ ] 1.2.3 子版号文本", "- [ ] 1.2 甲"],
            "sub-versioned prefixes must be preserved verbatim"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn overflowing_group_numbers_fail_soft_to_no_renumber() {
        // sharp-edge：标题数字超出 u64——解析失败即视为无数字标题，任务保留原文。
        let root = fixture_with_tasks_md(
            "renum-overflow",
            "## 99999999999999999999999. 巨数\n\n- [ ] 1.1 甲\n- [ ] 1.2 乙\n",
        );
        move_task_at(&root, "task-change", 1, 2, None).expect("move ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [ ] 1.2 乙", "- [ ] 1.1 甲"],
            "unparseable group numbers must not rewrite anything"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_task_done_accepts_stable_id_and_ordinal_domains() {
        // spec task-identity「桌面显示无标记且勾选命中」的 desktop core 端：
        // tsk_ 寻址命中带该 ID 的任务（重排无虞）、注解原文保留；纯数字走
        // ordinal 兼容路径；其余值回 Err。
        const TID: &str = "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let root = fixture_with_tasks_md(
            "dual-domain",
            &format!("## 1. 群组\n\n- [ ] 1.1 甲\n- [ ] 1.2 乙 <!-- specseal-task:{TID} -->\n"),
        );
        set_task_done_at(&root, "task-change", TID, true).expect("stable id toggle ok");
        let lines = task_lines(&root);
        assert!(lines[1].starts_with("- [x] 1.2 乙"), "stable id hits its task: {lines:?}");
        assert!(lines[1].contains(TID), "trailing comment preserved verbatim: {lines:?}");
        set_task_done_at(&root, "task-change", "1", true).expect("ordinal compat ok");
        assert!(task_lines(&root)[0].starts_with("- [x] 1.1 甲"));
        assert!(
            set_task_done_at(&root, "task-change", "abc", true).is_err(),
            "a value neither numeric nor tsk_-prefixed must error"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_task_done_does_not_renumber() {
        // 勾选不改顺序，也不得触发重编号——就算既有编号是乱的。
        // （task done 对无 ID 目标行会单行补章 stable ID 注解，故目标行以前缀比对。）
        let root = fixture_with_tasks_md("renum-toggle", "## 1. 群组\n\n- [ ] 1.9 甲\n- [ ] 1.5 乙\n");
        set_task_done_at(&root, "task-change", "1", true).expect("toggle ok");
        let lines = task_lines(&root);
        assert_eq!(lines.len(), 2);
        assert!(
            lines[0].starts_with("- [x] 1.9 甲"),
            "checked line keeps its numbering: {}",
            lines[0]
        );
        assert_eq!(lines[1], "- [ ] 1.5 乙");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn out_of_range_move_leaves_the_file_untouched() {
        let root = fixture_with_tasks_md("renum-oob", "## 1. 群组\n\n- [ ] 1.1 甲\n");
        let before = read_tasks(&root);
        assert!(move_task_at(&root, "task-change", 9, 1, None).is_err());
        assert!(move_task_at(&root, "task-change", 0, 1, None).is_err());
        assert_eq!(read_tasks(&root), before, "failed moves must not rewrite the file");
        let _ = fs::remove_dir_all(&root);
    }

    // --- 完成语意：GUI 勾任务与 CLI 完成语意一致（desktop-app spec）---

    const META_UNSTARTED: &str =
        "schema: spec-driven\ncreated: 2026-07-05\ncreated_by: momo\ncreated_with: claude\n";

    /// fixture 根转为 git repo（本地身分固定）；`dirty_rel` 给一个未认领的 dirty 程序档。
    fn giterize(root: &Path, dirty_rel: Option<&str>) {
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Desk Tester"]);
        git(&["config", "user.email", "desk@example.com"]);
        if let Some(rel) = dirty_rel {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "dirty\n").unwrap();
        }
    }

    // spec「任务写回非阻塞且串行化」Scenario「并发写回串行化」（design D3：写入串行化（全域写锁））
    #[test]
    fn concurrent_task_writes_serialize_without_lost_updates() {
        // 读-改-写竞态窗口极窄，多轮并发提高暴露几率；有锁后每轮皆确定无遗失。
        for round in 0..30 {
            let root = fixture_with_tasks_md(
                &format!("wlock-{round}"),
                "## 1. G\n\n- [x] 1.1 a\n- [x] 1.2 b\n",
            );
            let r1 = root.clone();
            let r2 = root.clone();
            let t1 = std::thread::spawn(move || set_task_done_at(&r1, "task-change", "1", false));
            let t2 = std::thread::spawn(move || set_task_done_at(&r2, "task-change", "2", false));
            t1.join().unwrap().expect("uncheck 1 ok");
            t2.join().unwrap().expect("uncheck 2 ok");
            let text = read_tasks(&root);
            assert!(
                text.contains("- [ ] 1.1 a") && text.contains("- [ ] 1.2 b"),
                "round {round}: lost update, tasks.md = {text:?}"
            );
            let _ = fs::remove_dir_all(&root);
        }
    }

    /// 对指定目录 git init 并设置身分（cached_git_identity 测试用，与 giterize 的固定身分区隔）。
    fn git_with_identity(root: &Path, name: &str, email: &str) {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", name],
            vec!["config", "user.email", email],
        ] {
            let ok = std::process::Command::new("git")
                .args(&args)
                .current_dir(root)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        }
    }

    // spec「任务写回非阻塞且串行化」Scenario「git 身分缓存重用」（design D1）
    #[test]
    fn cached_git_identity_is_per_root_and_stable() {
        let a = crate::testfixture::FixtureRoot::new("idcache-a");
        let b = crate::testfixture::FixtureRoot::new("idcache-b");
        git_with_identity(a.root(), "Alice", "alice@example.com");
        git_with_identity(b.root(), "Bob", "bob@example.com");
        // 缓存按根区分。
        assert_eq!(cached_git_identity(a.root()).as_deref(), Some("Alice <alice@example.com>"));
        assert_eq!(cached_git_identity(b.root()).as_deref(), Some("Bob <bob@example.com>"));
        // 同根重复调用回传缓存值——事后改 config 不重抓（app 存续期语意，重启才更新）。
        let _ = std::process::Command::new("git")
            .args(["config", "user.name", "Changed"])
            .current_dir(a.root())
            .output();
        assert_eq!(cached_git_identity(a.root()).as_deref(), Some("Alice <alice@example.com>"));
    }

    fn change_file(fx: &crate::testfixture::FixtureRoot, name: &str, file: &str) -> PathBuf {
        fx.root().join("specseal").join("changes").join(name).join(file)
    }

    fn meta_of(fx: &crate::testfixture::FixtureRoot, name: &str) -> String {
        fs::read_to_string(change_file(fx, name, ".meta.yaml")).unwrap()
    }

    /// 证据记录的家：change 目录的 `.evidence.json`（随 change 提交与封存移动）。
    fn touched_of(fx: &crate::testfixture::FixtureRoot, name: &str) -> Option<String> {
        fs::read_to_string(
            fx.root()
                .join("specseal")
                .join("changes")
                .join(name)
                .join(".evidence.json"),
        )
        .ok()
    }

    fn set_readonly(p: &Path, on: bool) {
        let mut perm = fs::metadata(p).unwrap().permissions();
        perm.set_readonly(on);
        fs::set_permissions(p, perm).unwrap();
    }

    #[test]
    fn set_task_done_true_stamps_meta_and_records_touched() {
        let fx = crate::testfixture::FixtureRoot::new("done-stamp");
        fx.add_change("demo", META_UNSTARTED);
        giterize(fx.root(), Some("src/main.rs"));

        set_task_done_at(fx.root(), "demo", "1", true).expect("check ok");

        let tasks = fs::read_to_string(change_file(&fx, "demo", "tasks.md")).unwrap();
        assert!(tasks.contains("- [x] 1.1 First task"), "task must be checked: {tasks}");
        // 与 CLI task done 相同的文件效果：meta 盖开工章（identity 沿 git 身分、agent 缺席）。
        let meta = meta_of(&fx, "demo");
        assert!(meta.starts_with(META_UNSTARTED), "existing meta preserved verbatim: {meta}");
        assert!(
            meta.contains(&format!("started_at: {}", specseal_core::util::today())),
            "first completion must stamp started_at: {meta}"
        );
        assert!(
            meta.contains("started_by: Desk Tester <desk@example.com>"),
            "git identity must be attributed: {meta}"
        );
        assert!(!meta.contains("started_with"), "no agent source → started_with absent: {meta}");
        // touched 记录与 CLI 同语意：未认领 dirty 档记于本任务项下。
        let touched = touched_of(&fx, "demo").expect("touched record written");
        assert!(touched.contains("src/main.rs"), "dirty file must be recorded: {touched}");
        assert!(touched.contains("\"task_id\": \"1\""), "entry attributed to task 1: {touched}");
    }

    #[test]
    fn set_task_done_true_on_done_task_is_an_idempotent_no_op() {
        let fx = crate::testfixture::FixtureRoot::new("done-idem");
        fx.add_change("demo", META_UNSTARTED);
        // 唯读 tasks.md：任何写入企图都会失败——幂等成功必须完全不写档。
        let tasks_path = change_file(&fx, "demo", "tasks.md");
        let before = fs::read_to_string(&tasks_path).unwrap();
        set_readonly(&tasks_path, true);
        let r = set_task_done_at(fx.root(), "demo", "2", true);
        set_readonly(&tasks_path, false);
        assert!(r.is_ok(), "duplicate done=true must be an idempotent success: {r:?}");
        assert_eq!(fs::read_to_string(&tasks_path).unwrap(), before);
        assert_eq!(meta_of(&fx, "demo"), META_UNSTARTED, "no stamp on the no-op path");
        assert!(touched_of(&fx, "demo").is_none(), "no touched record on the no-op path");
    }

    #[test]
    fn uncheck_and_move_never_touch_meta_or_touched_record() {
        let fx = crate::testfixture::FixtureRoot::new("no-sideeffect");
        fx.add_change("demo", META_UNSTARTED);
        // dirty 档在场更能证明「不记 touched」是行为而非碰巧无料可记。
        giterize(fx.root(), Some("src/lib.rs"));
        let touched_before = "{\n  \"change\": \"demo\",\n  \"touched\": []\n}";
        fx.write("specseal/changes/demo/.evidence.json", touched_before);

        set_task_done_at(fx.root(), "demo", "2", false).expect("uncheck ok");
        move_task_at(fx.root(), "demo", 1, 2, None).expect("move ok");

        assert_eq!(meta_of(&fx, "demo"), META_UNSTARTED, "meta must stay byte-identical");
        assert_eq!(
            touched_of(&fx, "demo").as_deref(),
            Some(touched_before),
            "touched record must stay byte-identical"
        );
    }

    #[test]
    fn desktop_ordinal_matches_engine_task_id_on_mixed_fixture() {
        // D3 风险钉死：同一 tasks.md（群组标题＋嵌套缩进＋非 checkbox 行混排），
        // desktop ordinal N 与引擎 task id N 必指同一任务。
        let mixed = "## 1. 群组甲\n\n前言说明不列入计数。\n\n- [ ] 1.1 首任务\n  - [ ] 嵌套子任务\n  - 纯列表项非 checkbox\n- [ ] 1.2 次任务\n\n## 2. 群组乙\n\n- [ ] 2.1 尾任务\n";
        for n in 1..=4 {
            let fx = crate::testfixture::FixtureRoot::new(&format!("align-{n}"));
            fx.add_change("demo", META_UNSTARTED);
            fx.write("specseal/changes/demo/tasks.md", mixed);
            set_task_done_at(fx.root(), "demo", &n.to_string(), true).expect("check ok");
            let text = fs::read_to_string(change_file(&fx, "demo", "tasks.md")).unwrap();
            let parsed = specseal_core::tasks::parse(&text);
            assert_eq!(parsed.len(), 4, "engine must see the same 4 checkboxes");
            assert!(
                parsed[n - 1].done,
                "engine task id {n} must be exactly the task desktop ordinal {n} checked: {text}"
            );
            assert_eq!(parsed.iter().filter(|t| t.done).count(), 1);
        }
    }

    // --- 批量任务动词（desktop-task-interactions spec「任务分页提供批量操作工具列」）---

    #[test]
    fn set_all_tasks_done_checks_everything_and_stamps_once() {
        // 全勾单次写回；开工章语意与逐一勾选一致；touched 仅记一笔（归于首个翻转任务）。
        let fx = crate::testfixture::FixtureRoot::new("all-done");
        fx.add_change("demo", META_UNSTARTED);
        giterize(fx.root(), Some("src/main.rs"));

        set_all_tasks_at(fx.root(), "demo", true).expect("batch check ok");

        let tasks = fs::read_to_string(change_file(&fx, "demo", "tasks.md")).unwrap();
        let parsed = specseal_core::tasks::parse(&tasks);
        assert_eq!(parsed.len(), 2, "checkbox count unchanged");
        assert!(parsed.iter().all(|t| t.done), "every task must be checked: {tasks}");
        assert!(tasks.contains("## 1. Group"), "non-checkbox lines intact");
        let meta = meta_of(&fx, "demo");
        assert!(meta.starts_with(META_UNSTARTED), "existing meta preserved verbatim: {meta}");
        assert!(
            meta.contains(&format!("started_at: {}", specseal_core::util::today())),
            "batch first completion must stamp started_at: {meta}"
        );
        assert!(
            meta.contains("started_by: Desk Tester <desk@example.com>"),
            "git identity must be attributed: {meta}"
        );
        let touched = touched_of(&fx, "demo").expect("touched record written");
        assert!(touched.contains("src/main.rs"), "dirty file recorded: {touched}");
        assert_eq!(
            touched.matches("task_id").count(),
            1,
            "batch must record exactly one touched entry: {touched}"
        );
    }

    #[test]
    fn set_all_tasks_done_when_already_done_is_a_no_write_no_op() {
        let fx = crate::testfixture::FixtureRoot::new("all-idem");
        fx.add_change("demo", META_UNSTARTED);
        set_all_tasks_at(fx.root(), "demo", true).expect("first batch ok");
        let tasks_path = change_file(&fx, "demo", "tasks.md");
        let tasks_before = fs::read_to_string(&tasks_path).unwrap();
        let meta_before = meta_of(&fx, "demo");
        // 唯读锁档：幂等路径必须零写档。
        set_readonly(&tasks_path, true);
        let r = set_all_tasks_at(fx.root(), "demo", true);
        set_readonly(&tasks_path, false);
        assert!(r.is_ok(), "repeat batch done must be idempotent success: {r:?}");
        assert_eq!(fs::read_to_string(&tasks_path).unwrap(), tasks_before);
        assert_eq!(meta_of(&fx, "demo"), meta_before, "no re-stamp on the no-op path");
    }

    #[test]
    fn set_all_tasks_reset_unchecks_without_stamp_or_touched() {
        // 重置：全部取消勾选、不盖开工章、不记 touched（dirty 档在场更能证明是行为）。
        let fx = crate::testfixture::FixtureRoot::new("all-reset");
        fx.add_change("demo", META_UNSTARTED);
        giterize(fx.root(), Some("src/lib.rs"));

        set_all_tasks_at(fx.root(), "demo", false).expect("batch reset ok");

        let tasks = fs::read_to_string(change_file(&fx, "demo", "tasks.md")).unwrap();
        assert!(
            specseal_core::tasks::parse(&tasks).iter().all(|t| !t.done),
            "every task must be unchecked: {tasks}"
        );
        assert_eq!(meta_of(&fx, "demo"), META_UNSTARTED, "reset must not stamp");
        assert!(touched_of(&fx, "demo").is_none(), "reset must not record touched");
        // 全未勾再重置：幂等成功、零写档（唯读锁档验证）。
        let tasks_path = change_file(&fx, "demo", "tasks.md");
        set_readonly(&tasks_path, true);
        let r = set_all_tasks_at(fx.root(), "demo", false);
        set_readonly(&tasks_path, false);
        assert!(r.is_ok(), "repeat reset must be idempotent success: {r:?}");
    }

    #[test]
    fn set_all_tasks_preserves_structure_and_rejects_bad_input() {
        // 群组标题与行序原样保留、仅 checkbox 标记翻转；守卫与单发一致。
        let root = fixture_with_tasks("all-preserve");
        set_all_tasks_at(&root, "task-change", true).expect("batch ok");
        assert_eq!(
            task_lines(&root),
            vec!["- [x] 1.1 first", "- [x] 1.2 second", "- [x] 2.1 third"],
            "only checkbox marks may change"
        );
        let text = read_tasks(&root);
        assert!(text.contains("## 1. Group A") && text.contains("## 2. Group B"));
        assert!(text.ends_with('\n'), "trailing newline preserved");
        assert!(set_all_tasks_at(&root, "no-such-xyz", true).is_err(), "unknown change errors");
        assert!(set_all_tasks_at(&root, "../specs", true).is_err(), "traversal rejected");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_change_unknown_or_unsafe_errors() {
        let root = fixture_with_change("safe", "kept-change");
        assert!(delete_change_at(&root, "no-such-xyz").is_err(), "unknown change errors");
        assert!(delete_change_at(&root, "../specs").is_err(), "traversal rejected");
        // 原 change 不受影响
        let ctx = crate::init_core_context(&root).unwrap();
        assert!(ctx.store.change_exists("kept-change"));
        let _ = fs::remove_dir_all(&root);
    }

    // --- 看板拖排写回（design D3/D5；desktop-card-reorder） ---

    /// 含 board_rank 的 change meta（add_change 的 tasks 固定 1 完成 1 未完成
    /// → 全卡同属 in-progress 栏）。
    fn ranked_meta(rank: &str) -> String {
        format!("schema: spec-driven\ncreated: 2026-07-01\ncreated_by: momo\nboard_rank: {rank}\n")
    }

    use crate::testfixture::board_names;

    fn rank_of(meta: &str) -> Option<String> {
        specseal_core::model::ChangeMeta::from_text(Some(meta)).expect("meta parses").board_rank
    }

    #[test]
    fn reorder_change_steady_state_writes_only_dragged_meta() {
        // spec「栏内拖排以中点 rank 单档写回」：稳态下只改被拖卡 meta，
        // 其余内容逐字节不变、邻居文件不动。
        let fx = crate::testfixture::FixtureRoot::new("r-steady");
        fx.add_change("one", &ranked_meta("b"));
        fx.add_change("two", &ranked_meta("f"));
        fx.add_change("three", &ranked_meta("t"));
        let one_before = meta_of(&fx, "one");
        let two_before = meta_of(&fx, "two");

        reorder_card_at(fx.root(), "change", "three", Some("one"), Some("two"))
            .expect("steady-state reorder ok");

        assert_eq!(meta_of(&fx, "one"), one_before, "neighbor files must not change");
        assert_eq!(meta_of(&fx, "two"), two_before, "neighbor files must not change");
        let three = meta_of(&fx, "three");
        let new_rank = rank_of(&three).expect("dragged card keeps a rank");
        assert!(
            "b" < new_rank.as_str() && new_rank.as_str() < "f",
            "new rank must be strictly between neighbors: {new_rank}"
        );
        // 除 board_rank 行外逐字节不变（原 rank 行原位代换）。
        assert_eq!(
            three.replacen(&format!("board_rank: {new_rank}\n"), "board_rank: t\n", 1),
            ranked_meta("t"),
            "only the board_rank line may differ: {three}"
        );
        assert_eq!(board_names(fx.root()), ["one", "three", "two"]);
    }

    #[test]
    fn reorder_change_stamps_whole_column_when_unranked_present() {
        // spec「栏内存在缺 rank 卡时整栏补章」：依当前显示序整栏派发后套用移动，
        // 不波及他栏。
        let fx = crate::testfixture::FixtureRoot::new("r-stamp");
        fx.add_change("a", META_UNSTARTED);
        fx.add_change("b", META_UNSTARTED);
        fx.add_change("c", META_UNSTARTED);
        // 他栏卡（proposed：零完成、未开工）不得被补章。
        fx.add_change("other-col", META_UNSTARTED);
        fx.write(
            "specseal/changes/other-col/tasks.md",
            "## 1. Group\n\n- [ ] 1.1 First task\n- [ ] 1.2 Second task\n",
        );
        let other_before = meta_of(&fx, "other-col");

        // 把 c 拖到栏顶（a 之前）。
        reorder_card_at(fx.root(), "change", "c", None, Some("a")).expect("stamp reorder ok");

        let (ra, rb, rc) = (
            rank_of(&meta_of(&fx, "a")).expect("a stamped"),
            rank_of(&meta_of(&fx, "b")).expect("b stamped"),
            rank_of(&meta_of(&fx, "c")).expect("c ranked"),
        );
        assert!(rc < ra && ra < rb, "order must be c < a < b, got c={rc} a={ra} b={rb}");
        assert_eq!(meta_of(&fx, "other-col"), other_before, "other column must be untouched");
        // 顶层顺序＝plan 配置序（阶段在前：进行中栏的三卡先于提案中的 other-col），
        // 栏内为 c、a、b。
        assert_eq!(board_names(fx.root()), ["c", "a", "b", "other-col"]);
        // 补章后 meta 仍以既有字段开头（byte 保留）。
        assert!(meta_of(&fx, "a").starts_with(META_UNSTARTED));
    }

    /// `.meta.yaml` 存在但解析失败的固定样本（与 core 测试同款）。
    const BAD_META: &str = ": : :\n\t bad yaml [unclosed\n";

    #[test]
    fn reorder_backfill_excludes_invalid_card_and_ranks_the_rest() {
        // spec「补章排除 invalid 卡且不中止」：同栏含缺 rank 有效卡与坏 metadata
        // 卡，触发整栏补章——仅有效卡被写入 board_rank，坏卡逐比特不变，
        // 其余补章照常完成（单一坏卡不得瘫痪整栏）。
        let fx = crate::testfixture::FixtureRoot::new("r-invalid-backfill");
        fx.add_change("a", META_UNSTARTED);
        fx.add_change("b", META_UNSTARTED);
        fx.add_change("broken", BAD_META); // 同栏（相同任务进度）但 metadata 损坏

        reorder_card_at(fx.root(), "change", "b", None, Some("a"))
            .expect("backfill must not die on the invalid card");

        assert!(rank_of(&meta_of(&fx, "a")).is_some(), "valid card stamped");
        assert!(rank_of(&meta_of(&fx, "b")).is_some(), "dragged card ranked");
        assert_eq!(meta_of(&fx, "broken"), BAD_META, "invalid card must not be written");
        let names = board_names(fx.root());
        assert!(
            names.contains(&"broken".to_string()),
            "board keeps listing the invalid card: {names:?}"
        );
    }

    #[test]
    fn reorder_of_the_invalid_card_itself_is_refused() {
        // spec「排序写入对坏 metadata 拒绝」桌面端到端：拖坏卡本身 → 引擎
        // 错误拒绝且文件逐比特不变。
        let fx = crate::testfixture::FixtureRoot::new("r-invalid-drag");
        fx.add_change("a", META_UNSTARTED);
        fx.add_change("broken", BAD_META);
        let err = reorder_card_at(fx.root(), "change", "broken", Some("a"), None)
            .expect_err("dragging the invalid card must be refused");
        assert!(
            err.contains("specseal/changes/broken/.meta.yaml"),
            "error must name the metadata file: {err}"
        );
        assert_eq!(meta_of(&fx, "broken"), BAD_META, "meta byte-identical");
    }

    #[test]
    fn reorder_discussion_writes_single_frontmatter_file() {
        // 讨论卡同语意：中点写回单档、邻居不动。
        let fx = crate::testfixture::FixtureRoot::new("r-disc");
        let doc = |slug: &str, rank: &str| {
            format!(
                "---\ntopic: T {slug}\nslug: {slug}\nstatus: open\nboard_rank: {rank}\ncreated: 2026-07-01\n---\n\n# Discussion: T {slug}\n\n## Context\n\nx\n\n## Rounds\n\n## Conclusion\n\n<!-- p -->\n"
            )
        };
        fx.write("specseal/discussions/alpha.md", &doc("alpha", "b"));
        fx.write("specseal/discussions/beta.md", &doc("beta", "n"));
        fx.write("specseal/discussions/gamma.md", &doc("gamma", "t"));
        let alpha_before = fs::read_to_string(fx.root().join("specseal/discussions/alpha.md")).unwrap();

        reorder_card_at(fx.root(), "discussion", "gamma", Some("alpha"), Some("beta"))
            .expect("discussion reorder ok");

        assert_eq!(
            fs::read_to_string(fx.root().join("specseal/discussions/alpha.md")).unwrap(),
            alpha_before,
            "neighbor discussion files must not change"
        );
        let gamma = fs::read_to_string(fx.root().join("specseal/discussions/gamma.md")).unwrap();
        let new_rank = {
            let line = gamma.lines().find(|l| l.starts_with("board_rank:")).expect("rank line");
            line.trim_start_matches("board_rank:").trim().to_string()
        };
        assert!("b" < new_rank.as_str() && new_rank.as_str() < "n", "b < {new_rank} < n violated");
        assert_eq!(
            gamma.replacen(&format!("board_rank: {new_rank}\n"), "board_rank: t\n", 1),
            doc("gamma", "t"),
            "only the frontmatter rank line may differ"
        );
    }

    // --- 拖排前的依赖检查（design D3；spec「栏内拖排以中点 rank 单档写回」）---

    #[test]
    fn reorder_across_a_declared_prerequisite_is_refused_and_keeps_the_rank() {
        // Scenario「跨越声明前置被拒」：c depends_on a、同栏，把 c 拖到 a 之前 →
        // Err 带引擎的 Display 文本、c 的 meta 逐比特不变、刷新后仍 a 在 c 前。
        let fx = crate::testfixture::FixtureRoot::new("r-dep-refused");
        fx.add_change("a", &ranked_meta("b"));
        fx.add_change("c", &format!("{}depends_on: a\n", ranked_meta("f")));
        let c_before = meta_of(&fx, "c");

        let err = reorder_card_at(fx.root(), "change", "c", None, Some("a"))
            .expect_err("crossing a declared prerequisite must be refused");

        assert!(err.contains("cannot move 'c' there") && err.contains("it depends on a"), "{err}");
        assert_eq!(meta_of(&fx, "c"), c_before, "dragged card's rank must not change");
        assert_eq!(board_names(fx.root()), ["a", "c"]);
    }

    #[test]
    fn reorder_refusal_writes_nothing_even_when_the_column_needs_stamps() {
        // 依赖检查在任何写入之前（引擎 move_rank，与 CLI 的 change rank 同一份）：
        // 栏内有缺 rank 卡、本该先补章，但移动被拒——a 与 c 都不写，顺序照旧。
        let fx = crate::testfixture::FixtureRoot::new("r-dep-refused-stamp");
        fx.add_change("a", META_UNSTARTED);
        fx.add_change("c", &format!("{META_UNSTARTED}depends_on: a\n"));
        let (a_before, c_before) = (meta_of(&fx, "a"), meta_of(&fx, "c"));

        reorder_card_at(fx.root(), "change", "c", None, Some("a"))
            .expect_err("crossing a declared prerequisite must be refused");

        assert_eq!(meta_of(&fx, "a"), a_before, "no backfill stamp on a refused move");
        assert_eq!(meta_of(&fx, "c"), c_before, "the dragged card is not written");
        assert_eq!(board_names(fx.root()), ["a", "c"]);
    }

    #[test]
    fn overlap_partners_may_swap_places() {
        // 只因 delta 重叠而依序的伙伴可互换先后（spec：仅因 delta 重叠而依序的
        // 伙伴 SHALL NOT 构成拒绝）。
        let fx = crate::testfixture::FixtureRoot::new("r-overlap-swap");
        fx.add_change("a", &ranked_meta("b"));
        fx.add_change("b", &ranked_meta("f"));
        for name in ["a", "b"] {
            fx.write(
                &format!("specseal/changes/{name}/specs/shared-cap/spec.md"),
                "## ADDED Requirements\n\n### Requirement: R\n\nText.\n",
            );
        }
        assert_eq!(board_names(fx.root()), ["a", "b"]);

        reorder_card_at(fx.root(), "change", "b", None, Some("a")).expect("overlap partners may swap");

        let ra = rank_of(&meta_of(&fx, "a")).unwrap();
        let rb = rank_of(&meta_of(&fx, "b")).unwrap();
        assert!(rb < ra, "b moved before a: a={ra} b={rb}");
        assert_eq!(board_names(fx.root()), ["b", "a"]);
    }

    #[test]
    fn reorder_restamps_the_column_when_rank_order_disagrees_with_the_display_order() {
        // Scenario「依赖修正后的栏拖排」：c（rank g）声明前置 a（rank n）→ 显示 a、c 但
        // rank 序 c<a；把 x 拖到 a、c 之间时中点键表达不了这个位置（审查 Round 1：
        // 旧行为键落到 c 之后、画面静默不动）。整栏先依显示序重派再套移动。
        let fx = crate::testfixture::FixtureRoot::new("r-restamp-inverted");
        fx.add_change("a", &ranked_meta("n"));
        fx.add_change("c", &format!("{}depends_on: a\n", ranked_meta("g")));
        fx.add_change("x", &ranked_meta("t"));
        assert_eq!(board_names(fx.root()), ["a", "c", "x"]);

        reorder_card_at(fx.root(), "change", "x", Some("a"), Some("c")).expect("drop between a and c");

        assert_eq!(board_names(fx.root()), ["a", "x", "c"]);
        let rank = |name: &str| rank_of(&meta_of(&fx, name)).unwrap();
        assert!(rank("a") < rank("x") && rank("x") < rank("c"), "a={} x={} c={}", rank("a"), rank("x"), rank("c"));
    }

    #[test]
    fn set_depends_rechecks_the_cycle_on_the_board_view_when_the_change_has_a_worktree() {
        // 审查 Round 1：a 有 worktree 映射时引擎的成环守门只看副本；分支后主 checkout
        // 才加的 b→a 边副本看不到。写入后以看板同源视图（overlay）复检，成环即撤销
        // 这条边、回引擎的成环消息，副本逐比特不变、看板不出 planError。
        let fx = crate::testfixture::FixtureRoot::new("m-depends-wt-cycle");
        fx.add_change("a", META_UNSTARTED);
        fx.add_change("b", META_UNSTARTED);
        let wt = fx.attach_worktree("a");
        fx.write("specseal/changes/b/.meta.yaml", &format!("{META_UNSTARTED}depends_on: a\n"));
        let a_wt = wt.change_dir("a").join(".meta.yaml");
        let a_before = fs::read_to_string(&a_wt).unwrap();

        let err = set_depends_at(fx.root(), "a", &on(&["b"]), false).expect_err("cycle on the board view");

        assert!(err.contains("dependency cycle"), "{err}");
        assert_eq!(fs::read_to_string(&a_wt).unwrap(), a_before, "the edge is rolled back");
        assert!(crate::query::list_changes_at(fx.root())["planError"].is_null());
    }

    // --- 前置的添加与移除（design D6；spec「详情抽屉的调度分页」）---

    fn on(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn set_depends_writes_and_removes_the_prerequisite_in_the_meta() {
        // Scenario「添加前置写回」：写入后 meta 含 depends_on: a，其余字节保留、
        // 前置卡不动；移除后该行消失。
        let fx = crate::testfixture::FixtureRoot::new("m-depends");
        fx.add_change("a", META_UNSTARTED);
        fx.add_change("b", META_UNSTARTED);
        let a_before = meta_of(&fx, "a");

        set_depends_at(fx.root(), "b", &on(&["a"]), false).expect("add prerequisite");
        let b = meta_of(&fx, "b");
        assert!(b.starts_with(META_UNSTARTED), "existing bytes preserved: {b}");
        assert!(b.contains("depends_on: a\n"), "{b}");
        assert_eq!(meta_of(&fx, "a"), a_before, "prerequisite card untouched");
        assert_eq!(
            crate::query::list_changes_at(fx.root())["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == "b")
                .unwrap()["dependsOn"],
            json!(["a"])
        );

        set_depends_at(fx.root(), "b", &on(&["a"]), true).expect("remove prerequisite");
        assert!(!meta_of(&fx, "b").contains("depends_on"), "{}", meta_of(&fx, "b"));
    }

    #[test]
    fn set_depends_refusals_come_from_the_engine_and_write_nothing() {
        // Scenario「引擎拒绝添加」：自依赖、不存在、成环 → Err 带引擎文本、meta 不变。
        let fx = crate::testfixture::FixtureRoot::new("m-depends-refused");
        fx.add_change("a", &format!("{META_UNSTARTED}depends_on: b\n"));
        fx.add_change("b", META_UNSTARTED);
        let b_before = meta_of(&fx, "b");

        let err = set_depends_at(fx.root(), "b", &on(&["b"]), false).expect_err("self");
        assert!(err.contains("cannot depend on itself"), "{err}");
        let err = set_depends_at(fx.root(), "b", &on(&["ghost"]), false).expect_err("unknown");
        assert!(err.contains("no active change with that name"), "{err}");
        let err = set_depends_at(fx.root(), "b", &on(&["a"]), false).expect_err("cycle");
        assert!(err.contains("dependency cycle: b -> a -> b"), "{err}");
        assert!(set_depends_at(fx.root(), "../evil", &on(&["a"]), false).is_err(), "unsafe name");

        assert_eq!(meta_of(&fx, "b"), b_before, "refusals write nothing");
    }

    #[test]
    fn depends_candidates_come_from_the_worktree_roster_when_the_change_has_one() {
        // desktop-app Scenario「worktree 映射时候选来自副本名册」：add-late 在分支后才于
        // 主 checkout 创建、副本里没有——选了会被引擎拒绝，所以不能列成候选。
        let fx = crate::testfixture::FixtureRoot::new("m-candidates-wt");
        fx.add_change("add-auth", META_UNSTARTED);
        fx.add_change("add-dark-mode", META_UNSTARTED);
        let _wt = fx.attach_worktree("add-dark-mode");
        fx.add_change("add-late", META_UNSTARTED);

        assert_eq!(depends_candidates_at(fx.root(), "add-dark-mode").unwrap(), ["add-auth"]);
        let listed = crate::query::list_changes_at(fx.root());
        assert!(
            listed["changes"].as_array().unwrap().iter().any(|c| c["name"] == "add-late"),
            "the board still lists add-late"
        );
        // 候选就是写入接受的名册：add-auth 可写、add-late 被拒。
        set_depends_at(fx.root(), "add-dark-mode", &on(&["add-auth"]), false)
            .expect("a roster candidate is accepted");
        let err = set_depends_at(fx.root(), "add-dark-mode", &on(&["add-late"]), false)
            .expect_err("an off-roster name is refused");
        assert!(err.contains("no active change with that name"), "{err}");
    }

    #[test]
    fn depends_candidates_without_a_worktree_are_the_checkouts_other_active_changes() {
        let fx = crate::testfixture::FixtureRoot::new("m-candidates");
        fx.add_change("b", META_UNSTARTED);
        fx.add_change("c", META_UNSTARTED);
        fx.add_change("a", META_UNSTARTED);
        assert_eq!(depends_candidates_at(fx.root(), "b").unwrap(), ["a", "c"]);
        assert!(depends_candidates_at(fx.root(), "../evil").is_err(), "unsafe name");
    }

    #[test]
    fn reorder_survives_vanished_neighbors_without_corrupting_meta() {
        // spec「邻居于写回前消失」：以现存邻居重导或落栏顶／栏底，不损坏 meta、不 panic。
        let fx = crate::testfixture::FixtureRoot::new("r-race");
        fx.add_change("solo", &ranked_meta("f"));
        reorder_card_at(fx.root(), "change", "solo", Some("ghost-prev"), Some("ghost-next"))
            .expect("vanished neighbors must not fail");
        let meta = meta_of(&fx, "solo");
        let parsed = specseal_core::model::ChangeMeta::from_text(Some(&meta)).expect("meta parses");
        assert_eq!(parsed.schema.as_deref(), Some("spec-driven"), "meta must keep parsing");
        assert!(parsed.board_rank.is_some(), "card keeps a valid rank");
    }

    #[test]
    fn reorder_rejects_bad_kind_unsafe_or_missing_ids() {
        let fx = crate::testfixture::FixtureRoot::new("r-guard");
        fx.add_change("demo", &ranked_meta("n"));
        let before = meta_of(&fx, "demo");
        assert!(reorder_card_at(fx.root(), "bogus", "demo", None, None).is_err(), "kind whitelist");
        assert!(reorder_card_at(fx.root(), "change", "../evil", None, None).is_err(), "traversal rejected");
        assert!(reorder_card_at(fx.root(), "change", "ghost", None, None).is_err(), "missing card errors");
        assert!(
            reorder_card_at(fx.root(), "change", "demo", Some("../evil"), None).is_err(),
            "unsafe neighbor ids rejected"
        );
        assert!(reorder_card_at(fx.root(), "discussion", "ghost", None, None).is_err(), "missing discussion errors");
        assert_eq!(meta_of(&fx, "demo"), before, "rejected calls must not write");
    }
}
