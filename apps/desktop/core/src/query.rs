//! 唯读查找：桌面 command 的数据源。
//!
//! 每个函数吃项目 `root`，经内嵌 core 回传与对应 CLI `--json` 同形状的 payload。
//! 非 specseal 项目目录时回传明确的空状态（空清单／None），不 panic。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use specseal_core::station::{self, ArchivedOutcome, Freshness, Station, StationId, StationProgress, StationStatus, REVIEW, VERIFY};
use specseal_core::store::Store;

use crate::init_core_context;

/// 清单项上的调度字段键（camelCase，与引擎 plan 列同名；spec client-protocol「变更清单的
/// 调度字段」「remote 变更清单的调度字段」）：本机与 remote 清单都照这份清单从 plan 列逐键
/// 搬运，两边的测试也共用——加字段只改这里。
pub const PLAN_FIELDS: &[&str] =
    &["wave", "blockedBy", "dependsOn", "overlaps", "requirementOverlap", "archiveAfter"];

/// 对应 `specseal list --json`：`{ "changes": [ … ] }` 加顶层 `planError`、`next`、`unpromotedCuts`。
/// 非项目回传同形的空清单：前端的 ChangeListPayload 四键都是必填。
pub fn list_changes_at(root: &Path) -> Value {
    let Some(ctx) = init_core_context(root) else {
        return json!({ "changes": [], "planError": null, "next": null, "unpromotedCuts": [] });
    };
    // Worktree 观察面：与 CLI list 同一组闸门与 payload 落点（design D6）。
    // 政策关、非主 checkout、git 不可用 → facts 为空，读写与 payload 与此功能
    // 出现前完全相同。
    let facts = crate::facts_for(&ctx);
    let overlaid = overlay_store(&ctx, &facts);
    let store: &dyn Store = if facts.is_empty() { &ctx.store } else { &overlaid };
    // 显示序＝引擎 plan 的配置顺序（design D1）：同一份 overlay 后的 store，与 CLI
    // plan 同一聚合面；成环时退回基底序，调度字段缺席（dependsOn 除外）、planError
    // 带成环消息。
    let (changes, plan) = board_order(store);
    let plan_row = |name: &str| {
        plan.as_ref()
            .ok()
            .and_then(|plan| plan.changes.iter().find(|p| p.name == name))
    };
    // 桌面 payload 在 CLI 同形项上叠加生命周期标记字段（parity 红线：CLI 的
    // changes_json 本身不动）。meta 类字段取自 list_changes 已解析的 meta；
    // whyExcerpt 例外——另读各 change 的 proposal.md 首段（描述列数据源）。
    let items: Vec<Value> = specseal_core::listing::changes_json_with(
        store,
        &changes,
        &specseal_host::worktree::payload_objects(&facts),
    )
        .iter()
        .zip(changes.iter())
        .map(|(item, c)| {
            let mut v = serde_json::to_value(item).unwrap_or_else(|_| json!({}));
            v["startedAt"] = json!(c.meta.started_at);
            v["startedBy"] = json!(c.meta.started_by);
            v["startedWith"] = json!(c.meta.started_with);
            v["createdBy"] = json!(c.meta.created_by);
            v["created"] = json!(c.meta.created);
            v["fromDiscussions"] = json!(c.meta.from_discussions());
            // 「待重新反映」徽章的数据源：恒存在（空数组＝无旗标），供看板卡片渲染。
            v["restaleFrom"] = json!(c.meta.restale_from());
            // 变更卡描述列的数据源：恒存在 key（缺件为 null），前端对 null 隐藏描述列。
            v["whyExcerpt"] =
                json!(store.read_artifact(&c.name, "proposal.md").as_deref().and_then(why_excerpt));
            // 审查状态（spec client-protocol「变更清单的审查状态字段」；design D6）：
            // 工单存在 → inReview；否则以 core 失效纯函数重算冻结度（有工作树的
            // client 端）——Fresh → reviewed、Stale → reviewedStale、Unknown（无章）
            // → none。章存在时附 reviewedAt／reviewedBy。
            // 内容指纹锚读的是 repo 任意程序档、不是 artifact——overlay 帮不上，
            // 逐 change 解析读取根（design D2）：有 worktree 映射读该副本，
            // 否则读主 checkout。任务锚已走 overlay，两锚自此同源；解析含
            // 存在性回退（worktree_root_for），与 overlay 的 of() 同步。
            let scope_root = crate::worktree_root_for(&ctx, &facts, &c.name)
                .unwrap_or(ctx.workspace.root.as_path());
            // 两站的失效判定共用这一个闭包，同一 scope 档会被问两次——缓存
            // 单次读取，避免大型 binary 资产在列表这条热路径被重复整档读入。
            let read_cache =
                std::cell::RefCell::new(std::collections::HashMap::<String, Option<Vec<u8>>>::new());
            let read_file = |p: &str| {
                read_cache
                    .borrow_mut()
                    .entry(p.to_string())
                    .or_insert_with(|| specseal_core::util::read_bytes_opt(&scope_root.join(p)))
                    .clone()
            };
            // 失效判定吃两组计数（写码任务锚）——`[M]` 手测任务的勾选不打黄卡片。
            let counts = specseal_core::tasks::counts_for(store, &c.name);
            // 写码进度三栏（spec client-protocol「变更清单的写码进度字段」）：
            // 「待手测」章的数据源，与失效判定共用这一份双组计数——呈现层不另
            // 行过滤 `[M]`。CLI 的 changes_json 不含这三栏。
            v["codeTotal"] = json!(counts.code_total);
            v["codeComplete"] = json!(counts.code_complete);
            v["codeRemaining"] = json!(counts.code_remaining);
            // 验证状态（spec client-protocol「变更清单的验证状态字段」；design
            // D5）与审查状态同构且互不屏蔽——两站可各自独立进行与盖章，故各判各的，
            // 共用同一份四态判定（[`station_view`]，remote 清单也走它）与同一个读取根。
            for st in [&REVIEW, &VERIFY] {
                let status = station::status(st, &c.meta, store.artifact_exists(&c.name, st.doc));
                let view = station_view(&status, &counts, Some(&read_file));
                if let Some(item) = v.as_object_mut() {
                    put_station_fields(item, st, &status, view);
                }
            }
            // 调度字段（spec client-protocol「变更清单的调度字段」）：照 PLAN_FIELDS
            // 从引擎 plan 列逐键照搬，不在呈现层另算；坏 meta（plan 的 skipped）的项
            // 没有这组键，卡片因字段缺席自动不显示章。成环时 dependsOn 以外的调度键
            // 缺席，dependsOn 仍给 meta 的声明原文（与 plan 列同一来源）——调度分页
            // 靠它让用户移除成环的前置。
            if let Some(row) = plan_row(&c.name) {
                let row = serde_json::to_value(row).unwrap_or_else(|_| json!({}));
                for &key in PLAN_FIELDS {
                    if let Some(value) = row.get(key) {
                        v[key] = value.clone();
                    }
                }
            } else if plan.is_err() && c.meta_error.is_none() {
                v["dependsOn"] = json!(c.meta.depends_on());
            }
            v
        })
        .collect();
    // 顶层的 next 与 unpromotedCuts（spec client-protocol「变更清单的调度字段」）取自
    // 同一次 plan 计算；成环时为 null 与空数组。
    match plan {
        Ok(plan) => json!({
            "changes": items,
            "planError": null,
            "next": plan.next,
            "unpromotedCuts": plan.unpromoted_cuts,
        }),
        Err(e) => json!({
            "changes": items,
            "planError": e.to_string(),
            "next": null,
            "unpromotedCuts": [],
        }),
    }
}

/// 一个品质站在卡片上的四态（station-status-and-landing D7）：本机与 remote 的清单
/// 共用这一份判定，差别只在关卡的事实从哪里来、有没有工作树可读。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StationView {
    /// 没有工单也没有章。
    None,
    /// 有未结的工单。
    InProgress,
    /// 已盖章，章的两个锚都还成立。
    Stamped,
    /// 已盖章，其后任务数或 scope 内的文件有变。
    StampedStale,
}

impl StationView {
    /// 清单项 `reviewStatus`／`verifyStatus` 的字符串。
    pub fn status_str(self, st: &Station) -> &'static str {
        match (st.id, self) {
            (_, StationView::None) => "none",
            (StationId::Review, StationView::InProgress) => "inReview",
            (StationId::Review, StationView::Stamped) => "reviewed",
            (StationId::Review, StationView::StampedStale) => "reviewedStale",
            (StationId::Verify, StationView::InProgress) => "inVerify",
            (StationId::Verify, StationView::Stamped) => "verified",
            (StationId::Verify, StationView::StampedStale) => "verifiedStale",
        }
    }
}

/// 已封存项 `reviewStatus`／`verifyStatus` 的字符串。结局由引擎判定（本机的封存缓存）或
/// 由在线回应给（remote 的已封存清单），字符串只有这一份。
pub fn archived_status_str(st: &Station, outcome: ArchivedOutcome) -> &'static str {
    match (st.id, outcome) {
        (_, ArchivedOutcome::None) => "none",
        (StationId::Review, ArchivedOutcome::Stamped) => "reviewed",
        (StationId::Review, ArchivedOutcome::NotPassed) => "reviewedNotPassed",
        (StationId::Verify, ArchivedOutcome::Stamped) => "verified",
        (StationId::Verify, ArchivedOutcome::NotPassed) => "verifiedNotPassed",
    }
}

/// 从关卡的事实算出四态。`status` 是本机读到的或在线回应给的同一种事实；`counts` 是
/// 目前的任务数；`read_file` 读工作树里 scope 档的现值——没有工作树（remote 项目没有
/// checkout）时给 `None`，只比任务锚。失效规则是引擎的 [`StationStatus::freshness`]，这里不另写。
pub fn station_view(
    status: &StationStatus,
    counts: &specseal_core::tasks::Counts,
    read_file: station::ScopeReader<'_>,
) -> StationView {
    match status.progress {
        StationProgress::None => StationView::None,
        StationProgress::InProgress => StationView::InProgress,
        StationProgress::Stamped => match status.freshness(counts, read_file) {
            Freshness::Stale => StationView::StampedStale,
            Freshness::Fresh | Freshness::Unknown => StationView::Stamped,
        },
    }
}

/// 把一个站的状态写进清单项：`reviewStatus`（验证站是 `verifyStatus`），章存在时另有
/// `reviewedAt`、`reviewedBy`（验证站是 `verifiedAt`、`verifiedBy`）。本机与 remote
/// 的清单项同形，看板卡片读同一组键。没有章时这两个键不存在。
pub fn put_station_fields(
    item: &mut serde_json::Map<String, Value>,
    st: &Station,
    status: &StationStatus,
    view: StationView,
) {
    item.insert(format!("{}Status", st.noun), json!(view.status_str(st)));
    let (at, by) = (format!("{}At", st.meta_prefix), format!("{}By", st.meta_prefix));
    if matches!(view, StationView::Stamped | StationView::StampedStale) {
        item.insert(at, json!(status.stamped_at));
        item.insert(by, json!(status.stamped_by));
    } else {
        // 同一项被重写成没有章的状态时（remote 的第二步），先前的章字段不留下。
        item.remove(&at);
        item.remove(&by);
    }
}

/// 批量入口的读取 store（design D2）：每个有映射的 change，其 artifact 读取转向
/// 该 worktree 副本，其余读取与全部写入直通主 store。一次处理全部 change 的入口
/// （看板清单、全文搜索）共用这一组装，不逐 change 重建 context——那会对每个
/// change 各 spawn 一次 git，刷新代价过高。
pub(crate) fn overlay_store<'a>(
    ctx: &'a crate::ProjectContext,
    facts: &specseal_host::worktree::WorktreeFacts,
) -> specseal_host::worktree::WorktreeOverlay<'a> {
    specseal_host::worktree::WorktreeOverlay::new(
        &ctx.store,
        facts
            .iter()
            .map(|(name, e)| {
                let store: Box<dyn Store> =
                    Box::new(specseal_fs::FsStore::new(&e.path, &ctx.workspace.spec_dir_name));
                (name.clone(), store)
            })
            .collect(),
    )
}

/// worktree 挂着时，这个 change 的破坏性动词要挡下来（design D7）。
///
/// 封存或退回会动主 checkout 的 change 目录，但真正的工作在 worktree 副本里——
/// 挡下比事后对帐便宜。唯读面（抽屉、查看、diff）不经此关。政策关闭、非主
/// checkout 或 git 不可用时无映射，一律放行。
///
/// 守门有意采 facts 原值、不跟随 `worktree_root_for` 的存在性回退：副本目录
/// 刚消失的竞态窗口内，对破坏性动词宁可多挡一次，也不放行。
pub(crate) fn refuse_if_worktree_is_open(
    ctx: &crate::ProjectContext,
    change: &str,
) -> Result<(), String> {
    let facts = crate::facts_for(ctx);
    match facts.get(change) {
        None => Ok(()),
        Some(entry) => Err(format!(
            "{change} 正在 worktree（{}）中进行，请先运行 specseal-worktree-merge 收尾再操作。",
            entry.branch
        )),
    }
}

/// 看板要跟着动的所有路径，第一项恒为 spec 目录本身（既有监看目标）。
///
/// worktree 流程下，进度写在别的文件夹：各 worktree 副本的 change 目录。再加上
/// 主 repo 的 `.git/worktrees/`，worktree 的增减本身也会触发刷新，卡片标示才会
/// 随 merge 收尾退场。登记簿要到第一个 worktree 创建才存在，此前以 `.git`
/// 目录本身代位（监看层对它非递归挂载）——等登记簿出生的事件驱动重挂。
/// 非项目或非 git repo 时只回 spec 目录一项——监看范围与此功能出现前相同。
pub fn watch_targets_at(root: &Path) -> Vec<PathBuf> {
    let Some(ctx) = init_core_context(root) else {
        return Vec::new();
    };
    let mut targets = vec![ctx.workspace.spec_dir()];
    let facts = crate::facts_for(&ctx);
    for (change, entry) in &facts {
        targets.push(
            entry
                .path
                .join(&ctx.workspace.spec_dir_name)
                .join("changes")
                .join(change),
        );
    }
    let git_dir = ctx.workspace.root.join(".git");
    let registry = git_dir.join("worktrees");
    if registry.is_dir() {
        targets.push(registry);
    } else if git_dir.is_dir() {
        targets.push(git_dir);
    }
    targets
}

/// 看板的基底序（design D2；spec「看板卡片顺序以 board_rank 字段为真相」）：引擎
/// plan 的基底序（阶段 → rank → 缺 rank 者依被依赖数、task 数、created → 名称），
/// 由引擎提供、不在这里另抄排序键；坏 meta 的卡不在其中，依名称接在后面。plan 成环
/// 时的退回序就是它。CLI 的 `specseal list --json` 排序不经此路径，逐比特不变。
pub(crate) fn board_sorted_changes(store: &dyn Store) -> Vec<specseal_core::model::Change> {
    let basis = specseal_core::plan::basis_order(store);
    let mut changes = specseal_core::model::list_changes(store);
    // list_changes 已依名称排序，稳定排序让不在基底序里的坏 meta 卡维持名称序。
    changes.sort_by_key(|c| basis.iter().position(|n| n == &c.name).unwrap_or(usize::MAX));
    changes
}

/// 看板显示序（design D1）：引擎 `plan::board_order` 给的顺序（plan 的配置顺序，成环时
/// 退回基底序），坏 meta（plan 的 skipped）的卡接在后面维持基底序。拖排的栏序由引擎
/// `plan::move_rank` 从同一个顺序算出，画面顺序与补章派发序同源。
pub(crate) fn board_order(
    store: &dyn Store,
) -> (
    Vec<specseal_core::model::Change>,
    Result<specseal_core::plan::Plan, specseal_core::plan::PlanError>,
) {
    let shown = specseal_core::plan::board_order(store);
    let shown: Vec<&str> = shown.iter().map(String::as_str).collect();
    let changes = plan_placed(board_sorted_changes(store), &shown, |c| c.name.as_str());
    (changes, specseal_core::plan::compute(store))
}

/// 看板显示序的排列规则（design D1；add-change-plan-remote D5／D6）：`placed`（plan 的配置
/// 序）列到的项照其顺序在前，其余维持 `basis` 原序接在后面；`placed` 里 basis 没有的名称
/// 略过。本地（basis＝基底序）与 remote（basis＝server 回传序）的清单与拖排共用这一条。
pub fn plan_placed<T>(mut basis: Vec<T>, placed: &[&str], name_of: impl Fn(&T) -> &str) -> Vec<T> {
    let mut ordered = Vec::with_capacity(basis.len());
    for name in placed {
        if let Some(i) = basis.iter().position(|item| name_of(item) == *name) {
            ordered.push(basis.remove(i));
        }
    }
    ordered.append(&mut basis);
    ordered
}

/// 对应 `specseal list --specs --json`：`{ "specs": … }`。非项目回传 `{ "specs": [] }`。
pub fn list_specs_at(root: &Path) -> Value {
    let Some(ctx) = init_core_context(root) else {
        return json!({ "specs": [] });
    };
    let store: &dyn Store = &ctx.store;
    // 桌面 payload 在 CLI 同形项上叠加呈现层辅助字段（design D2、spec-archive-drawer
    // design D4；parity 红线：CLI 的 specs_json_items 本身不动）。mtime 不可得时不插
    // key；规格卡字段恒存在（不可读／缺席文件为 0／null，清单照常回传）。
    let mut specs = specseal_core::listing::specs_json_items(store);
    if let Value::Array(items) = &mut specs {
        for item in items {
            let Some(id) = item["id"].as_str().map(str::to_string) else { continue };
            if let Some(date) = modified_date(&store.canonical_spec_path(&id)) {
                item["modifiedAt"] = json!(date);
            }
            let doc = store.read_canonical_spec(&id);
            let purpose = doc.as_deref().and_then(purpose_excerpt);
            item["requirementCount"] = json!(doc.as_deref().map_or(0, requirement_count));
            // 占位前缀的单一定义在 specseal-core（design D5）：产生器与侦测共用
            // 同一常数，两处字符串再也不会各自漂移。
            item["purposeTbd"] = json!(purpose
                .as_deref()
                .is_some_and(|p| p.starts_with(specseal_core::model::PURPOSE_TBD_PREFIX)));
            item["purposeExcerpt"] = json!(purpose);
            item["traceCount"] = json!(doc.as_deref().map_or(0, trace_count));
        }
    }
    json!({ "specs": specs })
}

/// 正式规格的 `### Requirement:` 标题数。
fn requirement_count(doc: &str) -> usize {
    doc.lines().filter(|l| l.trim().starts_with("### Requirement:")).count()
}

/// 正式规格 `## Purpose` 区段首个非空行原文；区段缺席或无内容时 `None`。
fn purpose_excerpt(doc: &str) -> Option<String> {
    let mut in_purpose = false;
    for line in doc.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("## ") {
            in_purpose = heading.trim() == "Purpose";
            continue;
        }
        if in_purpose && !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// 全文 `@trace` 注解区块内 `source:` 值的去重数（同一变更多次溯源计一次）。
fn trace_count(doc: &str) -> usize {
    let mut sources = std::collections::HashSet::new();
    let mut in_trace = false;
    for line in doc.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<!-- @trace") {
            in_trace = true;
            continue;
        }
        if in_trace {
            if let Some(src) = trimmed.strip_prefix("source:") {
                sources.insert(src.trim().to_string());
            }
            if trimmed.ends_with("-->") {
                in_trace = false;
            }
        }
    }
    sources.len()
}

/// proposal.md 的 `## Why` 区段首个非空行原文（board-card-anatomy design D2）；
/// 区段缺席或区段内无内容时 `None`。
pub(crate) fn why_excerpt(doc: &str) -> Option<String> {
    let mut in_why = false;
    for line in doc.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("## ") {
            in_why = heading.trim() == "Why";
            continue;
        }
        if in_why && !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// 文件 mtime 衍生的本地日期（YYYY-MM-DD）；metadata 或 mtime 不可得时 `None`。
pub(crate) fn modified_date(path: &Path) -> Option<String> {
    let mtime = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Local>::from(mtime).format("%Y-%m-%d").to_string())
}

/// 对应 `specseal status --change <name> --json`（`StatusReport` 串行化）。
/// change 不存在或非项目时回传 `Err` 附消息。
pub fn status_at(root: &Path, change: &str) -> Result<Value, String> {
    let ctx = crate::context_for_change(root, change)
        .ok_or_else(|| format!("not a specseal project: {}", root.display()))?;
    let store: &dyn Store = &ctx.store;
    let change = store
        .find_change(change)
        .ok_or_else(|| format!("change not found: {change}"))?;
    let schema = resolve_schema(&ctx.workspace, &change.meta.schema_name())?;
    let report = specseal_core::status::build(store, &change, &schema);
    serde_json::to_value(&report).map_err(|e| e.to_string())
}

/// 读取一个 change 的 artifact markdown。`artifact` 为 output path（如 `proposal.md`、
/// `design.md`、`specs/<cap>/spec.md`，同 status 的 `outputPath`）。无则 `None`。
///
/// 边界防护：`change`／`artifact` 含路径穿越（`..`）或绝对路径时视为无效回传 `None`，
/// 不让拼接后的路径逃出 change 目录读取任意文件。
pub fn document_at(root: &Path, change: &str, artifact: &str) -> Option<String> {
    if !is_safe_path_param(change) || !is_safe_path_param(artifact) {
        return None;
    }
    let ctx = crate::context_for_change(root, change)?;
    ctx.store.read_artifact(change, artifact)
}

/// 一份文档在磁盘上的位置（详情页「打开 ▾」，desktop-detail-page design D4）：绝对路径，
/// 与相对所在 checkout 根的路径（正斜线；菜单首列与失败 toast 的主词）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DocumentLocation {
    pub path: String,
    pub relative: String,
}

impl DocumentLocation {
    pub(crate) fn within(root: &Path, path: PathBuf) -> DocumentLocation {
        let relative = specseal_core::util::to_slash(path.strip_prefix(root).unwrap_or(&path));
        DocumentLocation { path: path.to_string_lossy().into_owned(), relative }
    }
}

/// change artifact 的磁盘位置——与 [`document_at`] 同一套解析：绑 worktree 时为 worktree
/// 副本、spec 目录名取自项目设置。不检查文件存在（缺档由 opener 回报）；含路径穿越的
/// 参数回 `None`。
pub fn document_location_at(root: &Path, change: &str, artifact: &str) -> Option<DocumentLocation> {
    if !is_safe_path_param(change) || !is_safe_path_param(artifact) {
        return None;
    }
    let ctx = crate::context_for_change(root, change)?;
    let path = ctx.store.layout().artifact_path(change, artifact);
    Some(DocumentLocation::within(&ctx.workspace.root, path))
}

/// 正式规格 spec.md 的磁盘位置（规格详情页「打开 ▾」）——与 [`spec_document_at`] 同一个
/// store，spec 目录名取自项目设置。不检查文件存在；含路径穿越的参数回 `None`。
pub fn spec_location_at(root: &Path, capability: &str) -> Option<DocumentLocation> {
    if !is_safe_path_param(capability) {
        return None;
    }
    let ctx = init_core_context(root)?;
    let path = ctx.store.layout().canonical_spec(capability);
    Some(DocumentLocation::within(&ctx.workspace.root, path))
}

/// 已封存 change 的 artifact 磁盘位置（已封存详情页「打开 ▾」）——与
/// [`archived_document_at`] 同一个 store；`artifact` 为 output path，逐段接在封存目录下。
/// 不检查文件存在；含路径穿越的参数回 `None`。
pub fn archived_document_location_at(
    root: &Path,
    dated_name: &str,
    artifact: &str,
) -> Option<DocumentLocation> {
    if !is_safe_path_param(dated_name) || !is_safe_path_param(artifact) {
        return None;
    }
    let ctx = init_core_context(root)?;
    let dir = ctx.store.layout().archived_change_dir(dated_name);
    let path = artifact.split('/').fold(dir, |p, c| p.join(c));
    Some(DocumentLocation::within(&ctx.workspace.root, path))
}

/// 读取一个 capability 的正式规格 spec.md。无则 `None`。含路径穿越的 `capability` 回传 `None`。
pub fn spec_document_at(root: &Path, capability: &str) -> Option<String> {
    if !is_safe_path_param(capability) {
        return None;
    }
    let ctx = init_core_context(root)?;
    ctx.store.read_canonical_spec(capability)
}

/// 列出一个 change 的 delta capability 名（供规格分页加载 specs/<cap>/spec.md）。
pub fn change_capabilities_at(root: &Path, change: &str) -> Vec<String> {
    if !is_safe_path_param(change) {
        return Vec::new();
    }
    match crate::context_for_change(root, change) {
        Some(ctx) => ctx.store.delta_capabilities(change),
        None => Vec::new(),
    }
}

/// 读取一个已封存 change 的 artifact 原文（dated_name 如 `2026-07-04-old`，
/// artifact 为 output path）。缺件或不存在回 `None`；路径穿越参数一律拒绝。
pub fn archived_document_at(root: &Path, dated_name: &str, artifact: &str) -> Option<String> {
    if !is_safe_path_param(dated_name) || !is_safe_path_param(artifact) {
        return None;
    }
    let ctx = init_core_context(root)?;
    ctx.store.read_archived_artifact(dated_name, artifact)
}

/// 列出一个已封存 change 的 delta capability 名（供唯读规格分页加载）。
pub fn archived_capabilities_at(root: &Path, dated_name: &str) -> Vec<String> {
    if !is_safe_path_param(dated_name) {
        return Vec::new();
    }
    match init_core_context(root) {
        Some(ctx) => ctx.store.archived_delta_capabilities(dated_name),
        None => Vec::new(),
    }
}

/// 工单分页的数据（spec desktop-app「详情抽屉的工单分页」）：[`ticket_payload`] 的形状，
/// 每轮与 CLI `<station> show --json` 的 `rounds` 项同形（design D1）。`station` 为
/// `review`／`verify`，其他值回 `None`；无工单、change 不存在或工单格式坏掉皆回
/// `None`——面板显示空态而非错误（design D2）。经 [`crate::context_for_change`]
/// 取 store，有 worktree 映射时读副本，与抽屉其他文档同源。
pub fn station_ticket_at(root: &Path, change: &str, station: &str) -> Option<Value> {
    if !is_safe_path_param(change) {
        return None;
    }
    let st = station_by_noun(station)?;
    let ctx = crate::context_for_change(root, change)?;
    ticket_json_parsed(st, &ctx.store.read_artifact(change, st.doc)?)
}

/// 已封存 change 带走的工单（spec desktop-app「已封存抽屉的工单分页」）：形状与
/// `None` 语意同 [`station_ticket_at`]，改读封存目录。
pub fn archived_station_ticket_at(root: &Path, dated_name: &str, station: &str) -> Option<Value> {
    if !is_safe_path_param(dated_name) {
        return None;
    }
    let st = station_by_noun(station)?;
    let ctx = init_core_context(root)?;
    ticket_json_parsed(st, &ctx.store.read_archived_artifact(dated_name, st.doc)?)
}

/// 工单原文 → D1 形状：远程封存文档只拿得到原文，壳层以此解析。站别未知或
/// 格式坏掉回 `None`。
pub fn ticket_json_from_text(station: &str, text: &str) -> Option<Value> {
    ticket_json_parsed(station_by_noun(station)?, text)
}

/// D1 形状：每轮交引擎 `Round::to_json`——与 CLI `--json` 同一份串行化，只是不带
/// `change`／`lastRound`（前端取数组末项）。
pub fn ticket_json(ticket: &station::Ticket) -> Value {
    ticket_payload(ticket.rounds.iter().map(station::Round::to_json).collect::<Vec<_>>())
}

/// 工单数据的唯一组装处：`{ "rounds": [ … ], "reviewBaselineSmells": [ … ] }`。本机与
/// 封存经 [`ticket_json`] 传入引擎串行化的轮次；远程活工单由壳层直接传入 server 回的
/// 轮次（同形）。`reviewBaselineSmells` 取自引擎常数，两站都带（套用规则列的展开清单）。
pub fn ticket_payload(rounds: impl serde::Serialize) -> Value {
    json!({ "rounds": rounds, "reviewBaselineSmells": specseal_core::skills::REVIEW_BASELINE_SMELLS })
}

fn ticket_json_parsed(st: &station::Station, text: &str) -> Option<Value> {
    station::parse_ticket(st, text).ok().map(|ticket| ticket_json(&ticket))
}

/// 站别的 CLI 词（`review`／`verify`）→ 站别常数；只认这两个值。壳层的远程
/// 指令也拿它守门：未知站别在拼 URL 或选封存文档名之前就回 `None`。
pub fn station_by_noun(noun: &str) -> Option<&'static station::Station> {
    [&REVIEW, &VERIFY].into_iter().find(|st| st.noun == noun)
}

/// 拒绝会逃出目标目录的路径参数：`..` 段、绝对路径、Windows 磁盘前缀。
pub(crate) fn is_safe_path_param(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    if s.starts_with('/') || s.starts_with('\\') || s.contains(':') {
        return false;
    }
    !s.split(['/', '\\']).any(|seg| seg == "..")
}

fn resolve_schema(
    ws: &specseal_core::workspace::Workspace,
    name: &str,
) -> Result<specseal_core::schema::Schema, String> {
    match specseal_core::schema::resolve_with(Some(ws), Some(&specseal_host::context::global_config_dir()), name) {
        Some(Ok(s)) => Ok(s),
        Some(Err(e)) => Err(e),
        None => Err(specseal_core::schema::not_found_msg(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testfixture::FixtureRoot;

    const OLD_META: &str = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: momo\ncreated_with: claude\n";
    const STARTED_META: &str = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: momo\ncreated_with: claude\nstarted_at: 2026-07-06\nstarted_by: Worker <w@example.com>\nstarted_with: claude\n";

    #[test]
    fn list_changes_shape_matches_cli_and_includes_active_change() {
        let fx = FixtureRoot::new("q-list");
        fx.add_change("demo", OLD_META);
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        assert_eq!(arr.len(), 1);
        let item = &arr[0];
        for key in ["name", "status", "totalTasks", "completedTasks", "summary"] {
            assert!(item.get(key).is_some(), "change item missing camelCase key {key}");
        }
        assert_eq!(item["name"], "demo");
        assert_eq!(item["totalTasks"], 2);
        assert_eq!(item["completedTasks"], 1);
    }

    // --- spec client-protocol「变更清单的写码进度字段」---

    #[test]
    fn list_changes_carries_code_progress_beside_the_full_counts() {
        // Scenario「清单项带写码进度」：九个已勾写码任务＋一个未勾 `[M]`。
        let fx = FixtureRoot::new("q-code-progress");
        fx.add_change("demo", OLD_META);
        let mut md = String::from("## 1. Group\n\n");
        for i in 1..=9 {
            md.push_str(&format!("- [x] 1.{i} task\n"));
        }
        md.push_str("- [ ] [M] 手动验证\n");
        fx.write("specseal/changes/demo/tasks.md", &md);
        let v = list_changes_at(fx.root());
        let item = &v["changes"][0];
        assert_eq!(item["codeTotal"], 9, "{item}");
        assert_eq!(item["codeComplete"], 9, "{item}");
        assert_eq!(item["codeRemaining"], 0, "{item}");
        // 既有字段不变（`[M]` 仍计入全量）。
        assert_eq!(item["totalTasks"], 10);
        assert_eq!(item["completedTasks"], 9);
    }

    #[test]
    fn code_progress_mirrors_full_counts_without_manual_tasks() {
        let fx = FixtureRoot::new("q-code-progress-plain");
        fx.add_change("demo", OLD_META);
        let item = &list_changes_at(fx.root())["changes"][0];
        assert_eq!(item["codeTotal"], 2, "{item}");
        assert_eq!(item["codeComplete"], 1, "{item}");
        assert_eq!(item["codeRemaining"], 1, "{item}");
    }

    #[test]
    fn list_changes_carries_the_worktree_object_for_a_mapped_change() {
        // spec worktree-overlay「desktop 看板的 worktree 呈现」Scenario「卡片标示
        // 与抽屉信息」：payload 带 camelCase 的 path 与 branch（皆为字符串）。
        let fx = FixtureRoot::new("q-list-wt");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");

        let v = list_changes_at(fx.root());
        let item = &v["changes"].as_array().expect("changes")[0];

        let worktree = item.get("worktree").expect("mapped change carries a worktree object");
        assert_eq!(worktree["branch"], "specseal/add-auth");
        assert_eq!(worktree["path"], wt.path().to_string_lossy().to_string());
        assert!(worktree["branch"].is_string() && worktree["path"].is_string());
    }

    #[test]
    fn watch_targets_cover_each_worktree_copy_and_the_worktree_registry() {
        // 进度写在 worktree 副本里，worktree 的增减写在 .git/worktrees/——两者都
        // 要监看，否则看板不会自动更新。
        let fx = FixtureRoot::new("q-watch-wt");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");

        let targets = watch_targets_at(fx.root());

        assert_eq!(targets[0], fx.root().join("specseal"), "第一项恒为 spec 目录");
        let want_copy = wt.change_dir("add-auth");
        assert!(targets.contains(&want_copy), "须监看 worktree 副本的 change 目录: {targets:?}");
        let want_registry = fx.root().join(".git").join("worktrees");
        assert!(targets.contains(&want_registry), "须监看 worktree 登记簿: {targets:?}");
        assert!(
            !targets.contains(&fx.root().join(".git")),
            "登记簿已存在时不需 .git 哨兵（避免多吞 git 杂讯）: {targets:?}"
        );
    }

    #[test]
    fn watch_targets_include_the_git_sentinel_before_the_first_worktree() {
        // 登记簿 .git/worktrees/ 要到第一个 worktree 创建才存在，而监看层会滤掉
        // 不存在的目录——推导须以 .git（非递归哨兵）代位，等登记簿出生的事件
        // 驱动重挂，否则第一个 worktree 的添加永远不会触发看板刷新。
        let fx = FixtureRoot::new("q-watch-git-sentinel");
        fx.add_change("demo", OLD_META);
        let out = std::process::Command::new("git")
            .current_dir(fx.root())
            .args(["init", "-q", "-b", "main"])
            .output()
            .expect("run git");
        assert!(out.status.success(), "git init: {}", String::from_utf8_lossy(&out.stderr));

        let targets = watch_targets_at(fx.root());

        assert_eq!(targets[0], fx.root().join("specseal"), "第一项恒为 spec 目录");
        assert!(
            targets.contains(&fx.root().join(".git")),
            "git repo 无 worktree 时须含 .git 哨兵: {targets:?}"
        );
        assert!(
            !targets.contains(&fx.root().join(".git").join("worktrees")),
            "登记簿尚不存在，不推导死路径: {targets:?}"
        );
    }

    #[test]
    fn watch_targets_are_just_the_spec_dir_without_worktrees() {
        let fx = FixtureRoot::new("q-watch-plain");
        fx.add_change("demo", OLD_META);
        assert_eq!(watch_targets_at(fx.root()), vec![fx.root().join("specseal")]);
    }

    #[test]
    fn watch_targets_are_empty_outside_a_project() {
        assert!(watch_targets_at(&crate::testfixture::fresh_non_project_dir("query-watch")).is_empty());
    }

    #[test]
    fn drawer_documents_come_from_the_worktree_copy() {
        // spec worktree-overlay「desktop 看板的 worktree 呈现」：抽屉各分页的文档
        // 原文与计数同源——计数已走 overlay，原文也必须来自同一份副本。
        let fx = FixtureRoot::new("q-doc-wt");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");
        let wt_change = wt.change_dir("add-auth");
        std::fs::write(wt_change.join("tasks.md"), TASKS_ALL_DONE).unwrap();
        std::fs::write(wt_change.join("design.md"), "## Context\n\nworktree 版设计。\n").unwrap();
        std::fs::create_dir_all(wt_change.join("specs").join("cap-wt")).unwrap();
        std::fs::write(
            wt_change.join("specs").join("cap-wt").join("spec.md"),
            "## ADDED Requirements\n",
        )
        .unwrap();

        let tasks = document_at(fx.root(), "add-auth", "tasks.md").expect("tasks.md 可读");
        assert!(tasks.contains("- [x] 1.1"), "任务分页原文须取 worktree 现值: {tasks}");
        assert_eq!(
            document_at(fx.root(), "add-auth", "design.md").as_deref(),
            Some("## Context\n\nworktree 版设计。\n"),
            "只存在于 worktree 的文档也要读得到"
        );
        assert_eq!(
            change_capabilities_at(fx.root(), "add-auth"),
            vec!["cap-wt"],
            "规格分页清单同源 worktree"
        );
    }

    #[test]
    fn worktree_context_is_built_directly_without_discovery() {
        // 审查 finding（Round 1）：定根不得走 discovery——向上探索在极端情境会走出
        // worktree、落到祖先目录的别的项目；副本的 .specseal.yaml 损坏时也不得静默
        // 回读主 checkout。映射条件只看「change 目录可读」，成立就以 worktree 路径
        // ＋主 checkout 的 spec 目录名直接建构（与 overlay 的组装同款）。
        let fx = FixtureRoot::new("q-wt-direct");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");
        std::fs::write(wt.path().join(".specseal.yaml"), ": : broken [yaml\n").unwrap();
        std::fs::write(
            wt.change_dir("add-auth").join("tasks.md"),
            TASKS_ALL_DONE,
        )
        .unwrap();

        let doc = document_at(fx.root(), "add-auth", "tasks.md").expect("tasks.md 可读");
        assert!(doc.contains("- [x] 1.1"), "直接组装、不受副本 app config 影响: {doc}");
    }

    #[test]
    fn status_report_comes_from_the_worktree_copy() {
        // 同一需求的状态报告面：design.md 只存在于 worktree 副本时，该 artifact
        // 的状态为 done（读主 checkout 会停在未完成）。
        let fx = FixtureRoot::new("q-status-wt");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");
        std::fs::write(
            wt.change_dir("add-auth").join("design.md"),
            "## Context\n\nworktree 版设计。\n",
        )
        .unwrap();

        let report = status_at(fx.root(), "add-auth").expect("status ok");
        let design = report["artifacts"]
            .as_array()
            .expect("artifacts array")
            .iter()
            .find(|a| a["id"] == "design")
            .expect("design artifact listed")
            .clone();
        assert_eq!(design["status"], "done", "状态报告须反映 worktree 副本: {report}");
        assert!(
            !fx.root().join("specseal/changes/add-auth/design.md").exists(),
            "主 checkout 确实没有这份文档（测试前提）"
        );
    }

    #[test]
    fn every_read_entry_falls_back_to_the_main_checkout_when_the_policy_is_off() {
        // design D4 红线：三道闸门任一不成立时 facts 为空——这里关掉 worktree 政策，
        // worktree 副本明明有更新的内容，全部读取面仍须读主 checkout（＝此功能出现
        // 前的行为）。
        let fx = FixtureRoot::new("q-policy-off");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");
        fx.write("specseal/config.yaml", "schema: spec-driven\nworktree: false\n");
        let wt_change = wt.change_dir("add-auth");
        std::fs::write(wt_change.join("tasks.md"), TASKS_ALL_DONE).unwrap();
        std::fs::write(wt_change.join("design.md"), "## Context\n\n只在 worktree。\n").unwrap();

        let v = list_changes_at(fx.root());
        let item = &v["changes"].as_array().expect("changes")[0];
        assert_eq!(item["completedTasks"], 1, "计数回到主 checkout: {item}");
        assert!(item.get("worktree").is_none_or(Value::is_null), "政策关则无标示: {item}");
        assert!(
            document_at(fx.root(), "add-auth", "tasks.md").unwrap().contains("- [ ] 1.1"),
            "文档回到主 checkout"
        );
        assert!(document_at(fx.root(), "add-auth", "design.md").is_none(), "副本的新档不外露");
        let report = status_at(fx.root(), "add-auth").expect("status ok");
        let design = report["artifacts"]
            .as_array()
            .expect("artifacts")
            .iter()
            .find(|a| a["id"] == "design")
            .expect("design listed")
            .clone();
        assert_ne!(design["status"], "done", "状态报告回到主 checkout: {report}");
        assert!(
            crate::search::search_workspace_at(fx.root(), "只在 worktree")["hits"]
                .as_array()
                .expect("hits")
                .is_empty(),
            "搜索不扫副本"
        );
    }

    #[test]
    fn reads_fall_back_to_the_main_checkout_once_the_worktree_is_removed() {
        // design D4：facts 每次现取、不缓存——worktree 移除后的下一次调用即回读
        // 主 checkout，没有 stale 窗口。
        let fx = FixtureRoot::new("q-wt-removed");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");
        std::fs::write(
            wt.change_dir("add-auth").join("tasks.md"),
            TASKS_ALL_DONE,
        )
        .unwrap();
        assert!(
            document_at(fx.root(), "add-auth", "tasks.md").unwrap().contains("- [x] 1.1"),
            "移除前读副本"
        );

        let out = std::process::Command::new("git")
            .args(["worktree", "remove", "--force", "wt"])
            .current_dir(fx.root())
            .output()
            .expect("run git");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        assert!(
            document_at(fx.root(), "add-auth", "tasks.md").unwrap().contains("- [ ] 1.1"),
            "移除后的下一次调用即回读主 checkout"
        );
    }

    #[test]
    fn list_changes_omits_the_worktree_object_without_a_mapping() {
        let fx = FixtureRoot::new("q-list-no-wt");
        fx.add_change("demo", OLD_META);
        let v = list_changes_at(fx.root());
        let item = &v["changes"].as_array().expect("changes")[0];
        assert!(item.get("worktree").is_none_or(Value::is_null), "无映射时不带 worktree: {item}");
    }

    #[test]
    fn list_changes_counts_tasks_from_the_worktree_copy() {
        // Scenario「worktree 内进度即时反映」：勾选发生在 worktree 副本，主看板
        // 的计数要跟着动（读经 overlay，而非主 checkout 的旧值）。
        let fx = FixtureRoot::new("q-list-wt-progress");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");
        let tasks = wt.change_dir("add-auth").join("tasks.md");
        std::fs::write(&tasks, "## 1. Group\n\n- [x] 1.1 First task\n- [x] 1.2 Second task\n")
            .unwrap();

        let v = list_changes_at(fx.root());
        let item = &v["changes"].as_array().expect("changes")[0];

        assert_eq!(item["completedTasks"], 2, "计数须来自 worktree 副本: {item}");
        assert_eq!(item["totalTasks"], 2);
    }

    #[test]
    fn list_changes_overlays_lifecycle_marker_fields() {
        // D2：桌面 payload 在 CLI 同形字段之上叠加 startedAt/startedBy/startedWith
        // （camelCase；未开工为 null）。数据来自已解析 meta，CLI 输出不受影响。
        let fx = FixtureRoot::new("q-overlay");
        fx.add_change("not-started", OLD_META);
        fx.add_change("underway", STARTED_META);
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        assert_eq!(arr.len(), 2);
        for item in arr {
            for key in ["startedAt", "startedBy", "startedWith"] {
                assert!(item.get(key).is_some(), "missing overlay key {key} on {item}");
            }
        }
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        let idle = by_name("not-started");
        assert!(idle["startedAt"].is_null());
        assert!(idle["startedBy"].is_null());
        assert!(idle["startedWith"].is_null());
        let underway = by_name("underway");
        assert_eq!(underway["startedAt"], "2026-07-06");
        assert_eq!(underway["startedBy"], "Worker <w@example.com>");
        assert_eq!(underway["startedWith"], "claude");
        // createdBy（camelCase）由 meta 盖章曝露、snake_case 不外泄（审计：边界无类型混淆）。
        assert_eq!(underway["createdBy"], "momo");
        assert!(underway.get("created_by").is_none(), "camelCase only");
        // 既有字段形状不变。
        assert_eq!(underway["totalTasks"], 2);
        assert_eq!(underway["completedTasks"], 1);
    }

    #[test]
    fn list_changes_overlays_created_date() {
        // 创建时间筛选的数据源（desktop-ux-polish design D5）：created（YYYY-MM-DD）
        // 由已解析 meta 曝露；CLI 输出不经此路径、逐比特不变。
        let fx = FixtureRoot::new("q-created");
        fx.add_change("demo", OLD_META);
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        assert_eq!(arr[0]["created"], "2026-07-01");
    }

    #[test]
    fn list_changes_overlays_from_discussions_as_array() {
        // 同源链接（多值化）：来自讨论的 change 于清单项带 fromDiscussions 数组，
        // 依 meta 顺序；多来源全列、单来源一元、非讨论而来为空数组。旧单值键 fromDiscussion 不再出现。
        let fx = FixtureRoot::new("q-fromdisc");
        fx.add_change(
            "multi",
            "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: alpha-search, beta-cache\n",
        );
        fx.add_change(
            "single",
            "schema: spec-driven\ncreated: 2026-07-01\nfrom_discussion: alpha-search\n",
        );
        fx.add_change("plain", OLD_META);
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        assert_eq!(
            by_name("multi")["fromDiscussions"],
            serde_json::json!(["alpha-search", "beta-cache"])
        );
        assert_eq!(by_name("single")["fromDiscussions"], serde_json::json!(["alpha-search"]));
        assert_eq!(by_name("plain")["fromDiscussions"], serde_json::json!([]));
        assert!(by_name("multi").get("fromDiscussion").is_none(), "old single-value key gone");
    }

    const TICKET: &str = "# Review — x\n\n## Round 1\n\n**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs — possible smell\n";
    const TASKS_ALL_DONE: &str = "## 1. Group\n\n- [x] 1.1 First task\n- [x] 1.2 Second task\n";

    // --- 四态的共用判定（station-status-and-landing D7；spec desktop-app「remote 项目的
    // 审查与验证标示」） ---

    fn stamped_status(tasks_total: usize, scope: &[(&str, &str)]) -> station::StationStatus {
        station::StationStatus {
            progress: station::StationProgress::Stamped,
            stamped_at: Some("2026-11-02".to_string()),
            tasks_total: Some(tasks_total),
            scope: scope
                .iter()
                .map(|(path, content)| specseal_core::model::ReviewedScopeEntry {
                    path: path.to_string(),
                    hash: station::content_fingerprint(content),
                })
                .collect(),
            ..station::StationStatus::none()
        }
    }

    fn task_counts(total: usize) -> specseal_core::tasks::Counts {
        let tasks = "- [x] t\n".repeat(total);
        specseal_core::tasks::counts(&specseal_core::tasks::parse(&tasks))
    }

    #[test]
    fn station_view_follows_the_facts_the_task_count_and_the_scope_files() {
        use station::{StationProgress, StationStatus};
        let files = [("src/a.rs", "fn a() {}\n"), ("src/b.rs", "fn b() {}\n")];
        let read = |changed: &'static str| {
            move |p: &str| {
                files.iter().find(|(path, _)| *path == p).map(|(path, content)| {
                    if *path == changed { b"fn changed() {}\n".to_vec() } else { content.as_bytes().to_vec() }
                })
            }
        };
        let unchanged = read("");
        let b_changed = read("src/b.rs");
        let in_progress = StationStatus { progress: StationProgress::InProgress, ..StationStatus::none() };
        let stamped = stamped_status(3, &files);

        // 进行中：有工单。
        assert_eq!(station_view(&in_progress, &task_counts(3), Some(&unchanged)), StationView::InProgress);
        // 已盖章且任务数不同：其后有变，不必读档。
        assert_eq!(station_view(&stamped, &task_counts(4), None), StationView::StampedStale);
        // 已盖章、任务数相同、没有读档函数：只比任务数。
        assert_eq!(station_view(&stamped, &task_counts(3), None), StationView::Stamped);
        // 已盖章、任务数相同、文件都没变。
        assert_eq!(station_view(&stamped, &task_counts(3), Some(&unchanged)), StationView::Stamped);
        // 已盖章、任务数相同、一个文件的指纹不同。
        assert_eq!(station_view(&stamped, &task_counts(3), Some(&b_changed)), StationView::StampedStale);
        // 没有数据：没有工单也没有章。
        assert_eq!(station_view(&StationStatus::none(), &task_counts(3), Some(&unchanged)), StationView::None);
    }

    #[test]
    fn station_fields_use_the_keys_the_board_reads() {
        let stamped = station::StationStatus {
            stamped_by: Some("Rev <r@example.com>".to_string()),
            ..stamped_status(3, &[("src/a.rs", "x")])
        };
        let mut item = serde_json::Map::new();
        put_station_fields(&mut item, &REVIEW, &stamped, StationView::StampedStale);
        put_station_fields(&mut item, &VERIFY, &station::StationStatus::none(), StationView::InProgress);
        assert_eq!(
            Value::Object(item),
            json!({
                "reviewStatus": "reviewedStale",
                "reviewedAt": "2026-11-02",
                "reviewedBy": "Rev <r@example.com>",
                "verifyStatus": "inVerify",
            })
        );
        let mut item = serde_json::Map::new();
        put_station_fields(&mut item, &REVIEW, &station::StationStatus::none(), StationView::None);
        put_station_fields(&mut item, &VERIFY, &stamped, StationView::Stamped);
        assert_eq!(item["reviewStatus"], "none");
        assert_eq!(item["verifyStatus"], "verified");
        assert_eq!(item["verifiedAt"], "2026-11-02");
        assert!(!item.contains_key("reviewedAt"), "no stamp fields without a stamp");
        // 同一项重写成没有章的状态时，先前的章字段不留下。
        put_station_fields(&mut item, &VERIFY, &station::StationStatus::none(), StationView::InProgress);
        assert_eq!(item["verifyStatus"], "inVerify");
        assert!(!item.contains_key("verifiedAt") && !item.contains_key("verifiedBy"), "{item:?}");
    }

    #[test]
    fn archived_outcomes_use_the_keys_the_archived_cards_read() {
        let table = [
            (ArchivedOutcome::None, "none", "none"),
            (ArchivedOutcome::Stamped, "reviewed", "verified"),
            (ArchivedOutcome::NotPassed, "reviewedNotPassed", "verifiedNotPassed"),
        ];
        for (outcome, review, verify) in table {
            assert_eq!(archived_status_str(&REVIEW, outcome), review);
            assert_eq!(archived_status_str(&VERIFY, outcome), verify);
        }
    }

    fn reviewed_meta(scope_path: &str, hash: &str) -> String {
        format!(
            "schema: spec-driven\ncreated: 2026-07-01\nreviewed_at: 2026-08-01\nreviewed_by: Rev <r@example.com>\nreviewed_with: claude\nreviewed_tasks_total: 2\nreviewed_scope:\n  - path: {scope_path}\n    hash: {hash}\n"
        )
    }

    #[test]
    fn list_changes_overlays_review_status_four_states() {
        // spec client-protocol「变更清单的审查状态字段」：工单存在 → inReview；
        // 章在且双锚符 → reviewed；章在锚不符 → reviewedStale；皆无 → none。
        // 章存在时附 reviewedAt／reviewedBy；冻结度于有工作树的 client 端重算。
        let fx = FixtureRoot::new("q-review");
        fx.add_change("plain", OLD_META);
        fx.add_change("underway", OLD_META);
        fx.write("specseal/changes/underway/review.md", TICKET);
        // reviewed：任务锚（2/2 全完成、盖章总数 2）与内容锚（现值指纹相符）皆符。
        let content = "fn keep() {}\n";
        fx.write("src/lib.rs", content);
        let hash = station::content_fingerprint(content);
        fx.add_change("stamped", &reviewed_meta("src/lib.rs", &hash));
        fx.write("specseal/changes/stamped/tasks.md", TASKS_ALL_DONE);
        // reviewedStale（spec Example「章在但指纹不符」）：scope 档其后追加了一行。
        let old_hash = station::content_fingerprint("fn keep() {}\n");
        fx.write("src/stale.rs", "fn keep() {}\nfn extra() {}\n");
        fx.add_change("gone-stale", &reviewed_meta("src/stale.rs", &old_hash));
        fx.write("specseal/changes/gone-stale/tasks.md", TASKS_ALL_DONE);

        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();

        assert_eq!(by_name("plain")["reviewStatus"], "none");
        assert!(by_name("plain").get("reviewedAt").is_none(), "no anchors without a stamp");
        assert_eq!(by_name("underway")["reviewStatus"], "inReview");
        assert!(by_name("underway").get("reviewedAt").is_none(), "in-review carries no stamp");
        let stamped = by_name("stamped");
        assert_eq!(stamped["reviewStatus"], "reviewed");
        assert_eq!(stamped["reviewedAt"], "2026-08-01");
        assert_eq!(stamped["reviewedBy"], "Rev <r@example.com>");
        let stale = by_name("gone-stale");
        assert_eq!(stale["reviewStatus"], "reviewedStale");
        assert_eq!(stale["reviewedAt"], "2026-08-01", "anchors survive the downgrade");
        // camelCase 边界：snake_case 不外泄；既有 CLI 形状字段不动。
        assert!(stamped.get("review_status").is_none() && stamped.get("reviewed_at").is_none());
        for key in ["name", "status", "totalTasks", "completedTasks", "summary"] {
            assert!(stamped.get(key).is_some(), "existing key {key} intact");
        }
    }

    #[test]
    fn review_freshness_handles_non_utf8_scope_bytes() {
        // design 契约「desktop 的 reviewStatus 重算同语意」：非 UTF-8 scope 档
        // 字节未变 → reviewed、变动 → reviewedStale。改动前这类档读不成文本、
        // 章恒判 stale——指纹分流后行为翻转，这里把翻转后的语意钉住。
        let fx = FixtureRoot::new("q-review-binary");
        let bin: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x00];
        std::fs::write(fx.root().join("logo.png"), bin).unwrap();
        let hash = station::content_fingerprint_bytes(bin);
        fx.add_change("bin-scope", &reviewed_meta("logo.png", &hash));
        fx.write("specseal/changes/bin-scope/tasks.md", TASKS_ALL_DONE);

        let v = list_changes_at(fx.root());
        assert_eq!(v["changes"][0]["reviewStatus"], "reviewed", "字节未变 → reviewed: {v}");

        std::fs::write(fx.root().join("logo.png"), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0xFF, 0x01])
            .unwrap();
        let v = list_changes_at(fx.root());
        assert_eq!(v["changes"][0]["reviewStatus"], "reviewedStale", "字节变动 → stale: {v}");
    }

    /// 带完整验证章的 meta（任务锚 2、内容锚 scope_path＋hash）。
    fn verified_meta(scope_path: &str, hash: &str) -> String {
        format!(
            "schema: spec-driven\ncreated: 2026-07-01\nverified_at: 2026-08-02\nverified_by: Ver <v@example.com>\nverified_with: claude\nverified_tasks_total: 2\nverified_scope:\n  - path: {scope_path}\n    hash: {hash}\n"
        )
    }

    #[test]
    fn list_changes_overlays_verify_status_four_states() {
        // spec client-protocol「变更清单的验证状态字段」：verify.md 存在 →
        // inVerify；章在且双锚符 → verified；章在锚不符 → verifiedStale；
        // 皆无 → none。章存在时附 verifiedAt／verifiedBy。
        let fx = FixtureRoot::new("q-verify");
        fx.add_change("plain", OLD_META);
        fx.add_change("underway", OLD_META);
        fx.write("specseal/changes/underway/verify.md", TICKET);
        let content = "fn keep() {}\n";
        fx.write("src/lib.rs", content);
        let hash = station::content_fingerprint(content);
        fx.add_change("stamped", &verified_meta("src/lib.rs", &hash));
        fx.write("specseal/changes/stamped/tasks.md", TASKS_ALL_DONE);
        let old_hash = station::content_fingerprint("fn keep() {}\n");
        fx.write("src/stale.rs", "fn keep() {}\nfn extra() {}\n");
        fx.add_change("gone-stale", &verified_meta("src/stale.rs", &old_hash));
        fx.write("specseal/changes/gone-stale/tasks.md", TASKS_ALL_DONE);

        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();

        assert_eq!(by_name("plain")["verifyStatus"], "none");
        assert!(by_name("plain").get("verifiedAt").is_none(), "no anchors without a stamp");
        assert_eq!(by_name("underway")["verifyStatus"], "inVerify");
        assert!(by_name("underway").get("verifiedAt").is_none(), "in-verify carries no stamp");
        let stamped = by_name("stamped");
        assert_eq!(stamped["verifyStatus"], "verified");
        assert_eq!(stamped["verifiedAt"], "2026-08-02");
        assert_eq!(stamped["verifiedBy"], "Ver <v@example.com>");
        let stale = by_name("gone-stale");
        assert_eq!(stale["verifyStatus"], "verifiedStale");
        assert_eq!(stale["verifiedAt"], "2026-08-02", "anchors survive the downgrade");
        assert!(stamped.get("verify_status").is_none() && stamped.get("verified_at").is_none());
    }

    #[test]
    fn the_two_stations_are_judged_independently() {
        // 讨论 code-review-stage 定案：两站互不屏蔽。审查章＋未结验证工单并存
        // 时，reviewStatus 仍是 reviewed、verifyStatus 是 inVerify——任一站的
        // 状态不得被另一站盖掉。
        let fx = FixtureRoot::new("q-both");
        let content = "fn keep() {}\n";
        fx.write("src/lib.rs", content);
        let hash = station::content_fingerprint(content);
        fx.add_change("mixed", &reviewed_meta("src/lib.rs", &hash));
        fx.write("specseal/changes/mixed/tasks.md", TASKS_ALL_DONE);
        fx.write("specseal/changes/mixed/verify.md", TICKET);

        let v = list_changes_at(fx.root());
        let item = v["changes"].as_array().unwrap()[0].clone();
        assert_eq!(item["reviewStatus"], "reviewed", "{item}");
        assert_eq!(item["verifyStatus"], "inVerify", "{item}");
        assert_eq!(item["reviewedBy"], "Rev <r@example.com>");
        assert!(item.get("verifiedAt").is_none(), "an open verify ticket carries no stamp");
    }

    /// 盖章时 scope 档的内容——指纹锚记的就是它的哈希。
    const STAMPED_SCOPE: &str = "fn keep() {}\n";

    /// 盖章 change ＋ worktree 映射：主 checkout 与 worktree 副本的 scope 档内容
    /// 分别指定，两份相异才看得出冻结度到底读了哪一份。
    fn stamped_change_with_worktree(tag: &str, main: &str, worktree: &str) -> FixtureRoot {
        let fx = FixtureRoot::new(tag);
        let hash = station::content_fingerprint(STAMPED_SCOPE);
        fx.write("src/auth.rs", main);
        fx.add_change("fix-auth", &reviewed_meta("src/auth.rs", &hash));
        fx.write("specseal/changes/fix-auth/tasks.md", TASKS_ALL_DONE);
        let wt = fx.attach_worktree("fix-auth");
        std::fs::write(wt.path().join("src").join("auth.rs"), worktree).unwrap();
        fx
    }

    #[test]
    fn review_freshness_reads_the_scope_file_from_the_worktree_copy() {
        // spec client-protocol Scenario「worktree 中盖章的冻结度以 worktree 现值
        // 判定」＋ Example 第一列：worktree 副本与盖章时一致、主 checkout 仍是
        // 未实作的旧内容 → reviewed。
        let fx = stamped_change_with_worktree(
            "q-review-wt-fresh",
            "fn unimplemented_yet() {}\n",
            STAMPED_SCOPE,
        );
        let v = list_changes_at(fx.root());
        assert_eq!(v["changes"][0]["reviewStatus"], "reviewed", "指纹锚须读 worktree 现值: {v}");
        assert_eq!(v["changes"][0]["reviewedAt"], "2026-08-01", "章的字段照常附带");
    }

    #[test]
    fn review_freshness_turns_stale_when_the_worktree_copy_drifts() {
        // 同 Example 第二列：worktree 内于盖章后再改该档 → reviewedStale。主
        // checkout 这次反而相符——读错一份就会停在 reviewed。
        let fx = stamped_change_with_worktree(
            "q-review-wt-stale",
            STAMPED_SCOPE,
            "fn keep() {}\nfn drifted() {}\n",
        );
        let v = list_changes_at(fx.root());
        assert_eq!(
            v["changes"][0]["reviewStatus"], "reviewedStale",
            "worktree 内变动后须转 stale: {v}"
        );
    }

    #[test]
    fn list_changes_overlays_why_excerpt_from_proposal() {
        // 变更卡描述列数据源（board-card-anatomy design D2）：whyExcerpt 为 proposal.md
        // `## Why` 区段首个非空行原文（camelCase、恒存在 key）；Why 前有其他区段不影响。
        let fx = FixtureRoot::new("q-why");
        fx.add_change("demo", OLD_META);
        fx.add_change("prefixed", OLD_META);
        fx.write(
            "specseal/changes/prefixed/proposal.md",
            "## Summary\n\nOne liner.\n\n## Why\n\nReal reason here.\nSecond line ignored.\n",
        );
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        assert_eq!(by_name("demo")["whyExcerpt"], "Demo change.");
        assert_eq!(by_name("prefixed")["whyExcerpt"], "Real reason here.");
        assert!(by_name("demo").get("why_excerpt").is_none(), "camelCase only");
    }

    #[test]
    fn why_excerpt_is_null_when_proposal_or_why_missing() {
        // 缺件容错（board-card-anatomy design D2）：无 proposal.md、Why 区段缺席或
        // 区段为空时 whyExcerpt 为 null，清单照常回传（描述列由前端缺席处理）。
        let fx = FixtureRoot::new("q-why-missing");
        fx.write("specseal/changes/no-proposal/.meta.yaml", OLD_META);
        fx.write("specseal/changes/no-proposal/tasks.md", "- [ ] 1.1 t\n");
        fx.add_change("empty-why", OLD_META);
        fx.write(
            "specseal/changes/empty-why/proposal.md",
            "## Why\n\n## What Changes\n\n- something\n",
        );
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        assert!(by_name("no-proposal")["whyExcerpt"].is_null(), "no proposal.md → null");
        assert!(by_name("empty-why")["whyExcerpt"].is_null(), "empty Why section → null");
    }

    #[test]
    fn list_changes_overlays_restale_from_as_array() {
        // 「待重新反映」徽章数据源：restale_from 非空的 change 于清单项带 restaleFrom 数组
        // （依 meta 顺序），无旗标为空数组。
        let fx = FixtureRoot::new("q-restale");
        fx.add_change(
            "stale",
            "schema: spec-driven\ncreated: 2026-07-01\nrestale_from: alpha, beta\n",
        );
        fx.add_change("fresh", OLD_META);
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        assert_eq!(by_name("stale")["restaleFrom"], serde_json::json!(["alpha", "beta"]));
        assert_eq!(by_name("fresh")["restaleFrom"], serde_json::json!([]));
    }

    #[test]
    fn list_changes_marks_invalid_card_and_keeps_the_board_open() {
        // spec「看板照常打开并标记损坏卡」：坏 metadata 卡带 metaError 诊断、
        // 有效卡不带，看板照常列出全部卡片。
        let fx = FixtureRoot::new("q-invalid-meta");
        fx.add_change("good", OLD_META);
        fx.add_change("broken", ": : :\n\t bad yaml [unclosed\n");
        let v = list_changes_at(fx.root());
        let arr = v["changes"].as_array().expect("changes array");
        assert_eq!(arr.len(), 2, "one corrupt card must not break the board");
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        let broken = by_name("broken");
        assert!(broken["metaError"].is_string(), "invalid card carries the diagnostic: {broken}");
        assert!(!broken["metaError"].as_str().unwrap().is_empty());
        assert!(by_name("good").get("metaError").is_none(), "valid card carries no diagnostic");
    }

    #[test]
    fn list_changes_sorts_by_board_rank_with_unranked_after_by_created() {
        // spec「看板卡片顺序以 board_rank 字段为真相」Example「四卡混排」：具值卡
        // 依 rank 字典序升幂在前，缺值卡殿后（刻意变更：原置顶）。
        let fx = FixtureRoot::new("q-rank-sort");
        fx.add_change("y", &format!("{OLD_META}board_rank: n\n"));
        fx.add_change("z", OLD_META);
        fx.add_change("x", &format!("{OLD_META}board_rank: f\n"));
        fx.add_change("w", &format!("{OLD_META}board_rank: b\n"));
        assert_eq!(board_names(fx.root()), ["w", "x", "y", "z"]);
    }

    #[test]
    fn unranked_cards_follow_created_ascending_so_new_work_queues_last() {
        // Scenario「新建的卡落栏底」：全员缺 rank 时依 created 升幂（刻意变更：原为
        // 修改时间序）——最新创建的卡在栏底，不插到用户排好的卡前面。
        let fx = FixtureRoot::new("q-created-order");
        fx.add_change("newest", "schema: spec-driven\ncreated: 2026-07-09\n");
        fx.add_change("oldest", "schema: spec-driven\ncreated: 2026-07-01\n");
        fx.add_change("middle", "schema: spec-driven\ncreated: 2026-07-05\n");
        fx.add_change("dateless", "schema: spec-driven\n");
        assert_eq!(board_names(fx.root()), ["oldest", "middle", "newest", "dateless"]);
    }

    #[test]
    fn list_changes_breaks_equal_rank_ties_by_name() {
        // design D2 同值决断：rank 相同以名称字典序，跨机器确定。
        let fx = FixtureRoot::new("q-rank-tie");
        fx.add_change("beta", &format!("{OLD_META}board_rank: n\n"));
        fx.add_change("alpha", &format!("{OLD_META}board_rank: n\n"));
        let v = list_changes_at(fx.root());
        let names: Vec<String> = v["changes"]
            .as_array()
            .expect("changes array")
            .iter()
            .map(|c| c["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["alpha", "beta"]);
    }

    // --- spec client-protocol「变更清单的调度字段」（design D1）---

    use crate::testfixture::board_names;

    #[test]
    fn plan_placed_puts_the_plan_order_first_and_keeps_the_rest_in_basis_order() {
        // 看板显示序的排列规则（本机基底序与 remote server 序共用）：plan 列到的照其序
        // 在前，没列到的（坏 meta、两次请求之间添加）维持 basis 原序接在后面；plan 有而
        // basis 没有的名称略过。
        let placed = plan_placed(vec!["d", "a", "c", "b"], &["c", "ghost", "a"], |s| *s);
        assert_eq!(placed, ["c", "a", "d", "b"]);
    }

    /// 在 `change` 的 desktop-app delta 以 MODIFIED 动到「看板与任务」。
    fn modify_board_requirement(fx: &FixtureRoot, change: &str) {
        fx.write(
            &format!("specseal/changes/{change}/specs/desktop-app/spec.md"),
            "## MODIFIED Requirements\n\n### Requirement: 看板与任务\n\nText.\n",
        );
    }

    #[test]
    fn list_change_carries_requirement_overlap_and_archive_after() {
        // Scenario「清单项带调度字段」：add-b 声明前置 add-a，add-b 与 add-c MODIFIED
        // 同一个 requirement 且 add-c 配置在 add-b 前（rank 让基底序为 add-b、add-c、
        // add-a，依赖修正后为 add-c、add-a、add-b）→ add-b 带 requirement 级重叠与
        // archiveAfter=["add-c"]；不重叠的 add-a 两键为空数组而非缺席。
        let fx = FixtureRoot::new("q-plan-requirement-overlap");
        fx.add_change("add-a", &format!("{OLD_META}board_rank: f\n"));
        fx.add_change("add-b", &format!("{OLD_META}board_rank: b\ndepends_on: add-a\n"));
        fx.add_change("add-c", &format!("{OLD_META}board_rank: c\n"));
        modify_board_requirement(&fx, "add-b");
        modify_board_requirement(&fx, "add-c");
        let v = list_changes_at(fx.root());
        assert!(v["planError"].is_null(), "{v}");
        assert_eq!(board_names(fx.root()), ["add-c", "add-a", "add-b"]);
        let arr = v["changes"].as_array().unwrap();
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        let overlap_with = |other: &str| {
            json!([{
                "change": other,
                "capability": "desktop-app",
                "requirement": "看板与任务",
                "ownOperation": "MODIFIED",
                "otherOperation": "MODIFIED",
                "conflict": false,
            }])
        };
        let b = by_name("add-b");
        assert_eq!(b["wave"], 2, "{b}");
        assert_eq!(b["blockedBy"], json!(["add-a"]), "{b}");
        assert_eq!(b["dependsOn"], json!(["add-a"]), "{b}");
        assert_eq!(b["requirementOverlap"], overlap_with("add-c"), "{b}");
        assert_eq!(b["archiveAfter"], json!(["add-c"]), "{b}");
        let c = by_name("add-c");
        assert_eq!(c["requirementOverlap"], overlap_with("add-b"), "{c}");
        assert_eq!(c["archiveAfter"], json!([]), "{c}");
        let a = by_name("add-a");
        assert_eq!(a["requirementOverlap"], json!([]), "{a}");
        assert_eq!(a["archiveAfter"], json!([]), "{a}");
    }

    #[test]
    fn cycle_omits_all_plan_keys_but_depends_on() {
        // Scenario「成环退回」：互依的 add-a 与 add-b 另动到同一个 requirement——
        // plan 失败时 dependsOn 以外的调度键（连同 requirementOverlap 与 archiveAfter）
        // 一起缺席，只有 dependsOn 留下声明原文（调度分页靠它解环）。
        let fx = FixtureRoot::new("q-plan-cycle-all-keys");
        fx.add_change("add-a", &format!("{OLD_META}depends_on: add-b\n"));
        fx.add_change("add-b", &format!("{OLD_META}depends_on: add-a\n"));
        modify_board_requirement(&fx, "add-a");
        modify_board_requirement(&fx, "add-b");
        let v = list_changes_at(fx.root());
        assert!(v["planError"].is_string(), "{v}");
        for item in v["changes"].as_array().unwrap() {
            for &key in PLAN_FIELDS {
                assert_eq!(item.get(key).is_some(), key == "dependsOn", "cycle → {key}: {item}");
            }
        }
    }

    #[test]
    fn list_changes_follows_plan_order_and_carries_the_plan_fields() {
        // Scenario「清单项带调度字段」：顺序为 plan 配置序（add-a 先于依赖它的
        // add-b，盖过 rank 基底序）、四键 camelCase、顶层 planError 为 null。
        // 三个同栏 change：add-b 声明前置 add-a、add-c 与 add-a 只共用一个 delta
        // 能力（各动不同 requirement）；rank 刻意让基底序为 add-b、add-a、add-c，
        // 依赖修正后才是 add-a 在前。
        let fx = FixtureRoot::new("q-plan-fields");
        fx.add_change("add-a", &format!("{OLD_META}board_rank: f\n"));
        fx.add_change("add-b", &format!("{OLD_META}board_rank: b\ndepends_on: add-a\n"));
        fx.add_change("add-c", OLD_META);
        for name in ["add-a", "add-c"] {
            fx.write(
                &format!("specseal/changes/{name}/specs/shared-cap/spec.md"),
                &format!("## ADDED Requirements\n\n### Requirement: R of {name}\n\nText.\n"),
            );
        }
        let v = list_changes_at(fx.root());
        assert_eq!(board_names(fx.root()), ["add-a", "add-b", "add-c"]);
        assert!(v["planError"].is_null(), "no cycle → planError null: {v}");
        let arr = v["changes"].as_array().unwrap();
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        let b = by_name("add-b");
        assert_eq!(b["wave"], 2, "{b}");
        assert_eq!(b["blockedBy"], json!(["add-a"]), "{b}");
        assert_eq!(b["dependsOn"], json!(["add-a"]), "{b}");
        assert_eq!(b["overlaps"], json!([]), "{b}");
        let a = by_name("add-a");
        assert_eq!(a["wave"], 1);
        assert_eq!(a["blockedBy"], json!([]));
        assert_eq!(a["overlaps"], json!([{ "change": "add-c", "capabilities": ["shared-cap"] }]));
        // 只共用 capability 的伙伴不推波次、不挡开工；目录级 overlaps 照列。
        let c = by_name("add-c");
        assert_eq!(c["wave"], 1, "a shared capability alone never delays a wave: {c}");
        assert_eq!(c["blockedBy"], json!([]));
        assert_eq!(c["dependsOn"], json!([]));
        assert_eq!(c["overlaps"], json!([{ "change": "add-a", "capabilities": ["shared-cap"] }]));
        for item in arr {
            for key in ["blocked_by", "depends_on"] {
                assert!(item.get(key).is_none(), "camelCase only: {item}");
            }
            // 既有字段不变。
            for key in ["name", "status", "totalTasks", "completedTasks", "codeTotal", "reviewStatus"] {
                assert!(item.get(key).is_some(), "existing key {key} kept: {item}");
            }
        }
        // Scenario「CLI 清单不含调度字段」：`specseal list --json` 的项走引擎的
        // changes_json，同一份 store 下调度键一律缺席（parity 红线的可运行断言）。
        let ctx = init_core_context(fx.root()).expect("project");
        let cli = serde_json::to_value(specseal_core::listing::changes_json(
            &ctx.store,
            &specseal_core::model::list_changes(&ctx.store),
        ))
        .unwrap();
        for item in cli.as_array().unwrap() {
            for key in PLAN_FIELDS {
                assert!(item.get(key).is_none(), "CLI list carries no {key}: {item}");
            }
        }
    }

    #[test]
    fn list_changes_falls_back_to_the_basis_order_on_a_dependency_cycle() {
        // Scenario「成环退回」：add-a 与 add-b 互依 → 顺序退回基底序（具 rank 的
        // add-c 在前、缺 rank 的依名称）、planError 为引擎成环消息；其余调度键的
        // 缺席由 cycle_omits_all_plan_keys_but_depends_on 钉住。
        let fx = FixtureRoot::new("q-plan-cycle");
        fx.add_change("add-a", &format!("{OLD_META}depends_on: add-b\n"));
        fx.add_change("add-b", &format!("{OLD_META}depends_on: add-a\n"));
        fx.add_change("add-c", &format!("{OLD_META}board_rank: n\n"));
        let v = list_changes_at(fx.root());
        assert_eq!(v["planError"], "dependency cycle: add-a -> add-b -> add-a", "{v}");
        assert_eq!(board_names(fx.root()), ["add-c", "add-a", "add-b"]);
        // dependsOn 仍为各自 meta 的声明原文——调度分页靠它让用户移除成环的前置
        // （审查 Round 1）。
        let by_name = |name: &str| {
            v["changes"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone()
        };
        assert_eq!(by_name("add-a")["dependsOn"], json!(["add-b"]));
        assert_eq!(by_name("add-b")["dependsOn"], json!(["add-a"]));
        assert_eq!(by_name("add-c")["dependsOn"], json!([]));
    }

    #[test]
    fn cycle_fallback_follows_the_engine_basis_order() {
        // 成环时退回的就是引擎的基底序：缺 rank 的卡依被依赖数在前——add-c 同时被
        // 成环的两者依赖，排在它们前面（只看 created 与名称会把它排最后）。
        let fx = FixtureRoot::new("q-plan-cycle-basis");
        fx.add_change("add-a", &format!("{OLD_META}depends_on: add-b, add-c\n"));
        fx.add_change("add-b", &format!("{OLD_META}depends_on: add-a, add-c\n"));
        fx.add_change("add-c", OLD_META);
        let v = list_changes_at(fx.root());
        assert!(v["planError"].is_string(), "the cycle is reported: {v}");
        assert_eq!(board_names(fx.root()), ["add-c", "add-a", "add-b"]);
    }

    /// 讨论 panel 的结论分两刀（cut 2 `add-y`、cut 3 `add-z`），只转出 add-y。
    fn write_panel_discussion(fx: &FixtureRoot) {
        fx.write(
            "specseal/discussions/panel.md",
            "---\ntopic: panel\nslug: panel\nstatus: promoted\npromoted_to: add-y\ncreated: 2026-09-01\n---\n\n\
             # Discussion: panel\n\n## Context\n\n背景。\n\n## Rounds\n\n\
             ### Round 1 — assumptions (2026-09-01)\n\n**Focus**: scope\n\n\
             ## Conclusion\n\n**Decision**: 定案。\n\n- **cut 2 `add-y`**: 第二刀\n- **cut 3 `add-z`**: 路线图\n",
        );
    }

    #[test]
    fn list_changes_carries_the_plan_next_and_unpromoted_cuts() {
        // Scenario「清单回应带尚未转出的刀」：add-x 已开工、add-y 为唯一的提案中变更
        // （plan 的 next），讨论 panel 的 cut 3 尚未转出 → 顶层 next 为 "add-y"、
        // unpromotedCuts 恰一项，五键 camelCase、与引擎 plan 同一次计算的值相同。
        let fx = FixtureRoot::new("q-plan-next-cuts");
        fx.add_change("add-x", STARTED_META);
        fx.add_change("add-y", OLD_META);
        fx.write("specseal/changes/add-y/tasks.md", "## 1. Group\n\n- [ ] 1.1 First task\n");
        write_panel_discussion(&fx);
        let v = list_changes_at(fx.root());
        assert!(v["planError"].is_null(), "{v}");
        assert_eq!(v["next"], "add-y", "{v}");
        assert_eq!(
            v["unpromotedCuts"],
            json!([{
                "discussion": "panel",
                "cut": "cut 3",
                "title": "路线图",
                "changes": ["add-z"],
                "unpromoted": ["add-z"],
            }]),
            "{v}"
        );
        let ctx = init_core_context(fx.root()).expect("project");
        let plan = specseal_core::plan::compute(&ctx.store).expect("no cycle");
        assert_eq!(v["next"], json!(plan.next));
        assert_eq!(v["unpromotedCuts"], serde_json::to_value(&plan.unpromoted_cuts).unwrap());
    }

    #[test]
    fn cycle_clears_the_plan_next_and_unpromoted_cuts() {
        // Scenario「成环退回」：plan 失败时 next 为 null、unpromotedCuts 为空数组——
        // 即使有一份讨论的刀尚未转出；planError 与六栏缺席的断言不变。
        let fx = FixtureRoot::new("q-plan-cycle-next-cuts");
        fx.add_change("add-a", &format!("{OLD_META}depends_on: add-b\n"));
        fx.add_change("add-b", &format!("{OLD_META}depends_on: add-a\n"));
        write_panel_discussion(&fx);
        let v = list_changes_at(fx.root());
        assert_eq!(v["planError"], "dependency cycle: add-a -> add-b -> add-a", "{v}");
        assert!(v.get("next").is_some_and(Value::is_null), "next present and null: {v}");
        assert_eq!(v["unpromotedCuts"], json!([]), "{v}");
        for item in v["changes"].as_array().unwrap() {
            for &key in PLAN_FIELDS {
                assert_eq!(item.get(key).is_some(), key == "dependsOn", "cycle → {key}: {item}");
            }
        }
    }

    #[test]
    fn list_changes_keeps_listing_a_corrupt_card_without_plan_fields() {
        // 坏 meta 项照旧列出（metaError 已在）且调度键缺席；有效卡照常带齐。
        let fx = FixtureRoot::new("q-plan-corrupt");
        fx.add_change("good", OLD_META);
        fx.add_change("broken", ": : :\n\t bad yaml [unclosed\n");
        let v = list_changes_at(fx.root());
        assert!(v["planError"].is_null());
        let arr = v["changes"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        let by_name = |name: &str| arr.iter().find(|c| c["name"] == name).unwrap().clone();
        let broken = by_name("broken");
        assert!(broken["metaError"].is_string());
        for key in PLAN_FIELDS {
            assert!(broken.get(key).is_none(), "corrupt card carries no {key}: {broken}");
            assert!(by_name("good").get(key).is_some(), "valid card carries {key}");
        }
    }

    #[test]
    fn list_specs_shape_matches_cli() {
        let fx = FixtureRoot::new("q-specs");
        fx.write("specseal/specs/cap-x/spec.md", "# cap-x Specification\n\n## Requirements\n");
        let v = list_specs_at(fx.root());
        let arr = v["specs"].as_array().expect("specs array");
        let ids: Vec<&str> = arr.iter().filter_map(|s| s["id"].as_str()).collect();
        assert!(ids.contains(&"cap-x"), "canonical spec present: {ids:?}");
    }

    #[test]
    fn list_specs_includes_card_info_fields() {
        // 规格卡收合信息数据源（spec-archive-drawer design D4）：requirementCount 为
        // `### Requirement:` 标题数、purposeExcerpt 为 Purpose 区段首个非空行原文、
        // traceCount 为全文 @trace 标记的 source 去重数；字段 camelCase。
        let fx = FixtureRoot::new("q-spec-card");
        fx.write(
            "specseal/specs/cap-x/spec.md",
            concat!(
                "# cap-x Specification\n\n",
                "## Purpose\n\nSearch behavior for the desktop app.\nSecond line ignored.\n\n",
                "## Requirements\n\n",
                "### Requirement: Alpha\n\nIt SHALL alpha.\n\n",
                "<!-- @trace\nsource: change-one\nupdated: 2026-07-01\ncode:\n  - a.rs\n-->\n\n---\n",
                "### Requirement: Beta\n\nIt SHALL beta.\n\n",
                "<!-- @trace\nsource: change-two\nupdated: 2026-07-02\ncode:\n  - b.rs\n-->\n\n---\n",
                "### Requirement: Gamma\n\nIt SHALL gamma.\n\n",
                "<!-- @trace\nsource: change-one\nupdated: 2026-07-03\ncode:\n  - c.rs\n-->",
            ),
        );
        let v = list_specs_at(fx.root());
        let arr = v["specs"].as_array().expect("specs array");
        let item = arr.iter().find(|s| s["id"] == "cap-x").expect("cap-x listed");
        assert_eq!(item["requirementCount"], 3);
        assert_eq!(item["purposeExcerpt"], "Search behavior for the desktop app.");
        assert_eq!(item["purposeTbd"], false);
        assert_eq!(item["traceCount"], 2, "source 去重：change-one 出现两次计一次");
        for key in ["requirement_count", "purpose_excerpt", "purpose_tbd", "trace_count"] {
            assert!(item.get(key).is_none(), "camelCase only: {key}");
        }
    }

    #[test]
    fn list_specs_purpose_tbd_flags_archive_placeholder() {
        // 占位侦测钉的是 specseal-core 的公开常数（design D5）：产生器与侦测共用
        // 同一份字符串，所以残留占位的正式规格必被标为 purposeTbd。内核常数若变动，
        // 这份 fixture 随之变动，侦测不需要跟着改。
        let fx = FixtureRoot::new("q-spec-tbd");
        fx.write(
            "specseal/specs/cap-new/spec.md",
            &format!(
                "# cap-new Specification\n\n## Purpose\n\n{} change 'demo'. Update Purpose after archive.\n\n## Requirements\n\n### Requirement: Fresh works\n\nIt SHALL work.\n",
                specseal_core::model::PURPOSE_TBD_PREFIX
            ),
        );
        let v = list_specs_at(fx.root());
        let arr = v["specs"].as_array().expect("specs array");
        let item = arr.iter().find(|s| s["id"] == "cap-new").expect("cap-new listed");
        assert_eq!(item["purposeTbd"], true);
        assert_eq!(item["requirementCount"], 1);
    }

    #[test]
    fn spec_card_fields_tolerate_minimal_content() {
        // 容错（Implementation Contract 失败模式）：无 Purpose 区段、无 Requirement、
        // 无 @trace 的规格计数字段为 0、excerpt 为 null，清单照常回传。
        let fx = FixtureRoot::new("q-spec-card-bare");
        fx.write("specseal/specs/bare/spec.md", "# bare Specification\n");
        let v = list_specs_at(fx.root());
        let arr = v["specs"].as_array().expect("specs array");
        let item = arr.iter().find(|s| s["id"] == "bare").expect("bare listed");
        assert_eq!(item["requirementCount"], 0);
        assert!(item["purposeExcerpt"].is_null());
        assert_eq!(item["purposeTbd"], false);
        assert_eq!(item["traceCount"], 0);
    }

    #[cfg(unix)]
    #[test]
    fn spec_card_fields_tolerate_unreadable_file() {
        // 不可读文件（列出后权限被拒）：该笔字段 0／null，清单照常回传且其他规格不受影响，
        // 不因单笔坏档让整页失败。
        use std::os::unix::fs::PermissionsExt;
        let fx = FixtureRoot::new("q-spec-card-unreadable");
        fx.write("specseal/specs/ok/spec.md", "## Purpose\n\nFine.\n\n### Requirement: A\n\nx\n");
        fx.write("specseal/specs/locked/spec.md", "## Purpose\n\nHidden.\n");
        let locked = fx.root().join("specseal/specs/locked/spec.md");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let v = list_specs_at(fx.root());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        let arr = v["specs"].as_array().expect("specs array");
        let bad = arr.iter().find(|s| s["id"] == "locked").expect("locked still listed");
        assert_eq!(bad["requirementCount"], 0);
        assert!(bad["purposeExcerpt"].is_null());
        assert_eq!(bad["purposeTbd"], false);
        assert_eq!(bad["traceCount"], 0);
        let good = arr.iter().find(|s| s["id"] == "ok").expect("ok listed");
        assert_eq!(good["requirementCount"], 1);
        assert_eq!(good["purposeExcerpt"], "Fine.");
    }

    #[test]
    fn list_specs_includes_modified_at_from_mtime() {
        // 呈现层辅助字段（design D2）：规格清单查找对每个 spec 带 modifiedAt——
        // spec.md 文件系统 mtime 的本地日期（YYYY-MM-DD）。刚写入的文件即今天。
        let fx = FixtureRoot::new("q-specs-mtime");
        fx.write("specseal/specs/cap-x/spec.md", "# cap-x Specification\n");
        let v = list_specs_at(fx.root());
        let arr = v["specs"].as_array().expect("specs array");
        let item = arr.iter().find(|s| s["id"] == "cap-x").expect("cap-x listed");
        assert_eq!(item["modifiedAt"], specseal_core::util::today().as_str());
    }

    #[test]
    fn modified_date_is_absent_when_mtime_unavailable() {
        // mtime 不可得时字段缺席（衍生为 None、overlay 不插 key，而非塞 null）。
        let fx = FixtureRoot::new("q-specs-no-mtime");
        let ghost = fx.root().join("specseal/specs/ghost/spec.md");
        assert!(modified_date(&ghost).is_none());
    }

    #[test]
    fn status_shape_matches_cli() {
        let fx = FixtureRoot::new("q-status");
        fx.add_change("demo", OLD_META);
        let v = status_at(fx.root(), "demo").expect("status ok");
        for key in ["changeName", "schemaName", "isComplete", "applyRequires", "artifacts"] {
            assert!(v.get(key).is_some(), "status missing camelCase key {key}");
        }
        assert_eq!(v["changeName"], "demo");
    }

    #[test]
    fn evidence_record_never_shows_up_as_a_change_artifact() {
        // design Risk「.evidence.json 意外出现在桌面 artifact 清单」：证据记录是
        // 机器写入的 dot 档，与 `.meta.yaml` 同待遇——不进 artifact 清单、
        // 不进规格分页的 capability 清单、不成为搜索命中的 artifact 名。
        // 三个面在固定 schema 清单下对 dot 档永真，所以再放一个非 dot 的 stray
        // 档当判别器：哪天清单改成扫目录，stray 档会现形、此测试才会真的失败。
        let fx = FixtureRoot::new("q-evidence-hidden");
        fx.add_change("demo", OLD_META);
        fx.write(
            "specseal/changes/demo/.evidence.json",
            r#"{"version":2,"change":"demo","entries":[{"taskId":"1","taskDesc":"1.1 a","touchedFiles":["src/searchable-token.rs"],"basisDigests":{"spec":"sha256:0","tasks":"sha256:0","policy":"sha256:0"},"recordedAt":"2026-07-13T00:00:00Z"}]}"#,
        );
        fx.write("specseal/changes/demo/stray-notes.md", "searchable-token stray notes\n");

        let v = status_at(fx.root(), "demo").expect("status ok");
        let paths: Vec<&str> = v["artifacts"]
            .as_array()
            .expect("artifacts array")
            .iter()
            .filter_map(|a| a["outputPath"].as_str())
            .collect();
        assert!(!paths.is_empty(), "the schema's own artifacts are still listed: {paths:?}");
        for p in &paths {
            assert!(
                !p.starts_with('.'),
                "machine-written dot files stay out of the artifact list: {paths:?}"
            );
        }
        assert!(
            !paths.contains(&"stray-notes.md"),
            "the artifact list comes from the schema, not a directory scan: {paths:?}"
        );

        assert!(
            !change_capabilities_at(fx.root(), "demo").iter().any(|c| c.starts_with('.')),
            "the record is not a capability"
        );
        // 搜索扫的是固定 artifact 序，证据记录的内容不会成为命中来源。
        let hits = crate::search::search_workspace_at(fx.root(), "searchable-token");
        assert_eq!(
            hits["hits"].as_array().map(|a| a.len()),
            Some(0),
            "evidence content is not searchable change text: {hits}"
        );
    }

    #[test]
    fn status_unknown_change_errors() {
        let fx = FixtureRoot::new("q-status-unknown");
        fx.add_change("demo", OLD_META);
        assert!(status_at(fx.root(), "no-such-change-xyz").is_err());
    }

    #[test]
    fn document_reads_change_artifact() {
        // artifact 以 output path 寻址（与 status 的 outputPath 一致）。
        let fx = FixtureRoot::new("q-doc");
        fx.add_change("demo", OLD_META);
        let doc = document_at(fx.root(), "demo", "proposal.md").expect("proposal exists");
        assert!(doc.contains("## Why"));
    }

    #[test]
    fn spec_document_reads_canonical() {
        let fx = FixtureRoot::new("q-canonical");
        fx.write("specseal/specs/cap-x/spec.md", "# cap-x Specification\n");
        let doc = spec_document_at(fx.root(), "cap-x").expect("spec exists");
        assert!(!doc.trim().is_empty());
    }

    #[test]
    fn document_rejects_path_traversal() {
        // 没有防护时 `../../../secret.txt` 会逃出 change 目录读到项目根的文件。
        let fx = FixtureRoot::new("q-traversal");
        fx.add_change("demo", OLD_META);
        fx.write("secret.txt", "top secret");
        assert!(
            document_at(fx.root(), "demo", "../../../secret.txt").is_none(),
            "traversal in artifact must be rejected"
        );
        assert!(
            document_at(fx.root(), "../..", "secret.txt").is_none(),
            "traversal in change name must be rejected"
        );
        assert!(
            spec_document_at(fx.root(), "../../secret").is_none(),
            "traversal in capability must be rejected"
        );
    }

    #[test]
    fn archived_document_reads_content_and_lists_capabilities() {
        let fx = FixtureRoot::new("q-archived");
        fx.write(
            "specseal/changes/archive/2026-07-04-old/.meta.yaml",
            "schema: spec-driven\ncreated: 2026-07-01\narchived_at: 2026-07-04\n",
        );
        fx.write("specseal/changes/archive/2026-07-04-old/proposal.md", "## Why\n\nOld body.\n");
        fx.write("specseal/changes/archive/2026-07-04-old/tasks.md", "- [x] 1.1 done\n");
        fx.write(
            "specseal/changes/archive/2026-07-04-old/specs/cap-x/spec.md",
            "## ADDED Requirements\n",
        );

        assert_eq!(
            archived_document_at(fx.root(), "2026-07-04-old", "proposal.md").unwrap(),
            "## Why\n\nOld body.\n"
        );
        assert_eq!(archived_capabilities_at(fx.root(), "2026-07-04-old"), vec!["cap-x"]);
        // 缺件文档回 None（前端显示空状态，不是错误）。
        assert!(archived_document_at(fx.root(), "2026-07-04-old", "design.md").is_none());
        assert!(archived_document_at(fx.root(), "2026-01-01-ghost", "proposal.md").is_none());
    }

    #[test]
    fn archived_document_rejects_path_traversal() {
        let fx = FixtureRoot::new("q-archived-traversal");
        fx.write("specseal/changes/archive/2026-07-04-old/proposal.md", "## Why\n");
        fx.write("secret.txt", "top secret");

        assert!(
            archived_document_at(fx.root(), "2026-07-04-old", "../../../../secret.txt").is_none(),
            "traversal in artifact must be rejected"
        );
        assert!(
            archived_document_at(fx.root(), "../..", "secret.txt").is_none(),
            "traversal in dated name must be rejected"
        );
        assert!(
            archived_document_at(fx.root(), "2026-07-04-old", "C:\\evil.txt").is_none(),
            "drive-prefixed artifact must be rejected"
        );
        assert!(archived_capabilities_at(fx.root(), "../..").is_empty());
    }

    /// 两轮结构化工单：首轮三级各一，复验轮带行尾 `(accepted)` token。Patch 行
    /// 要 64 个小写十六进位字符，故以函数组字符串而非 const。
    fn two_round_ticket() -> String {
        format!(
            "# Review — x\n\n## Round 1\n\n**Phase**: discovery\n**Patch**: sha256:{a}\n**Scope**: src/a.rs, src/b.rs, src/c.rs\n\n- [CRITICAL] src/a.rs — Correctness: 未处理空清单\n- [WARNING] src/b.rs — Standards: 命名不一致\n- [SUGGESTION] src/c.rs — Style: 可简化\n\n## Round 2\n\n**Phase**: validation\n**Patch**: sha256:{b}\n**Scope**: src/a.rs, src/b.rs, src/c.rs\n\n- [WARNING] src/b.rs — Standards: 命名不一致 (accepted)\n- [SUGGESTION] src/c.rs — Style: 可简化\n",
            a = "a".repeat(64),
            b = "b".repeat(64),
        )
    }

    #[test]
    fn station_ticket_mirrors_the_cli_rounds_shape() {
        // spec desktop-app「详情抽屉的工单分页」：工单数据形状与 CLI
        // `review show --json` 的 rounds 相同（design D1）——camelCase、每轮五栏、
        // findings 三栏；不带 lastRound／change／content。
        let fx = FixtureRoot::new("q-ticket-shape");
        fx.add_change("x", OLD_META);
        fx.write("specseal/changes/x/review.md", &two_round_ticket());

        let v = station_ticket_at(fx.root(), "x", "review").expect("ticket present");
        let rounds = v["rounds"].as_array().expect("rounds array");
        assert_eq!(rounds.len(), 2);
        let r1 = &rounds[0];
        for key in ["index", "phase", "patchHash", "rules", "scope", "findings"] {
            assert!(r1.get(key).is_some(), "round missing camelCase key {key}: {r1}");
        }
        assert_eq!(v["reviewBaselineSmells"], json!(specseal_core::skills::REVIEW_BASELINE_SMELLS));
        assert_eq!(r1["index"], 1);
        assert_eq!(r1["phase"], "discovery");
        assert_eq!(r1["patchHash"], format!("sha256:{}", "a".repeat(64)));
        assert_eq!(r1["scope"], json!(["src/a.rs", "src/b.rs", "src/c.rs"]));
        assert_eq!(
            r1["findings"],
            json!([
                { "severity": "CRITICAL", "path": "src/a.rs", "text": "Correctness: 未处理空清单" },
                { "severity": "WARNING", "path": "src/b.rs", "text": "Standards: 命名不一致" },
                { "severity": "SUGGESTION", "path": "src/c.rs", "text": "Style: 可简化" },
            ])
        );
        let r2 = &rounds[1];
        assert_eq!(r2["index"], 2);
        assert_eq!(r2["phase"], "validation");
        // 描述原文照传——`(accepted)` token 的辨识是前端呈现规则（design D4）。
        assert_eq!(r2["findings"][0]["text"], "Standards: 命名不一致 (accepted)");
        assert!(r1.get("patch_hash").is_none(), "snake_case must not leak");
        assert!(v.get("lastRound").is_none() && v.get("change").is_none() && v.get("content").is_none());
    }

    #[test]
    fn station_ticket_legacy_round_carries_explicit_nulls() {
        // legacy 轮（无 Phase／Patch）：两栏恒出现、值为 null——与 wire 的
        // additive shape 同款，前端不必分辨「缺键」与「null」。
        let fx = FixtureRoot::new("q-ticket-legacy");
        fx.add_change("x", OLD_META);
        fx.write("specseal/changes/x/verify.md", TICKET);

        let v = station_ticket_at(fx.root(), "x", "verify").expect("verify ticket present");
        let r = &v["rounds"][0];
        assert!(r.get("phase").is_some() && r.get("patchHash").is_some(), "{r}");
        assert_eq!(r["phase"], Value::Null);
        assert_eq!(r["patchHash"], Value::Null);
        assert_eq!(r["findings"][0]["severity"], "WARNING");
    }

    #[test]
    fn station_ticket_is_none_without_a_ticket_or_for_an_unknown_station() {
        let fx = FixtureRoot::new("q-ticket-none");
        fx.add_change("x", OLD_META);
        assert!(station_ticket_at(fx.root(), "x", "review").is_none(), "no ticket → None");
        fx.write("specseal/changes/x/review.md", TICKET);
        assert!(station_ticket_at(fx.root(), "x", "verify").is_none(), "the other station's ticket does not count");
        assert!(station_ticket_at(fx.root(), "x", "quality").is_none(), "unknown station → None");
        assert!(station_ticket_at(fx.root(), "ghost", "review").is_none(), "unknown change → None");
        assert!(station_ticket_at(fx.root(), "../..", "review").is_none(), "traversal in change name → None");
    }

    #[test]
    fn station_ticket_is_none_when_the_ticket_is_corrupt() {
        // 坏格式（Round 标头非数字）→ None：面板显示空态而非错误（design D2），
        // 与其他文档分页「缺件即空态」同款。
        let fx = FixtureRoot::new("q-ticket-corrupt");
        fx.add_change("x", OLD_META);
        fx.write("specseal/changes/x/review.md", "# Review — x\n\n## Round one\n\n**Scope**: src/lib.rs\n");
        assert!(station_ticket_at(fx.root(), "x", "review").is_none());
    }

    #[test]
    fn station_ticket_comes_from_the_worktree_copy() {
        // spec worktree-overlay「desktop 看板的 worktree 呈现」：工单与抽屉其他
        // 文档同源——有映射时读 worktree 副本。主 checkout 一轮、副本两轮，
        // 读错一份会停在一轮。
        let fx = FixtureRoot::new("q-ticket-wt");
        fx.add_change("x", OLD_META);
        fx.write("specseal/changes/x/review.md", TICKET);
        let wt = fx.attach_worktree("x");
        std::fs::write(wt.change_dir("x").join("review.md"), two_round_ticket()).unwrap();

        let v = station_ticket_at(fx.root(), "x", "review").expect("ticket present");
        assert_eq!(v["rounds"].as_array().unwrap().len(), 2, "must read the worktree copy: {v}");
    }

    #[test]
    fn archived_station_ticket_mirrors_the_live_shape() {
        // spec desktop-app「已封存抽屉的工单分页」：带走的 verify.md 解析成与活
        // 变更相同的形状（同一串行化落点）；另一站无工单、幽灵封存、未知站别、
        // 路径穿越皆回 None。
        let fx = FixtureRoot::new("q-archived-ticket");
        let carried = two_round_ticket().replace("# Review — x", "# Verify — old");
        fx.write(
            "specseal/changes/archive/2026-07-04-old/.meta.yaml",
            "schema: spec-driven\ncreated: 2026-07-01\narchived_at: 2026-07-04\n",
        );
        fx.write("specseal/changes/archive/2026-07-04-old/proposal.md", "## Why\n\nOld body.\n");
        fx.write("specseal/changes/archive/2026-07-04-old/verify.md", &carried);

        let v = archived_station_ticket_at(fx.root(), "2026-07-04-old", "verify").expect("carried ticket");
        let rounds = v["rounds"].as_array().expect("rounds array");
        assert_eq!(rounds.len(), 2);
        for key in ["index", "phase", "patchHash", "rules", "scope", "findings"] {
            assert!(rounds[1].get(key).is_some(), "round missing camelCase key {key}: {v}");
        }
        assert_eq!(v["reviewBaselineSmells"], json!(specseal_core::skills::REVIEW_BASELINE_SMELLS));
        assert_eq!(rounds[1]["index"], 2);
        assert_eq!(rounds[1]["phase"], "validation");
        assert_eq!(rounds[1]["scope"], json!(["src/a.rs", "src/b.rs", "src/c.rs"]));
        assert_eq!(
            rounds[1]["findings"][1],
            json!({ "severity": "SUGGESTION", "path": "src/c.rs", "text": "Style: 可简化" })
        );
        assert_eq!(v, ticket_json_from_text("verify", &carried).unwrap(), "one serializer for every entry point");
        assert!(archived_station_ticket_at(fx.root(), "2026-07-04-old", "review").is_none(), "no review ticket carried");
        assert!(archived_station_ticket_at(fx.root(), "2026-01-01-ghost", "verify").is_none());
        assert!(archived_station_ticket_at(fx.root(), "2026-07-04-old", "quality").is_none());
        assert!(archived_station_ticket_at(fx.root(), "../..", "verify").is_none());
    }

    #[test]
    fn ticket_payload_carries_the_baseline_smells_and_the_round_rules() {
        // spec desktop-app「详情页的工单分页」的工单数据形状（D5）：本机活变更、本机
        // 封存与原文解析三条路都带 reviewBaselineSmells（引擎常数）与每轮 rules。
        let text = format!(
            "# Review — x\n\n## Round 1\n\n**Phase**: discovery\n**Patch**: sha256:{}\n**Rules**: extend\n\
             **Rule**: CRITICAL 所有 SQL 一律用参数化查找，不得用字符串拼接\n**Scope**: src/a.rs\n\n\
             ## Round 2\n\n**Phase**: validation\n**Patch**: sha256:{}\n**Scope**: src/a.rs\n",
            "a".repeat(64),
            "b".repeat(64)
        );
        let fx = FixtureRoot::new("q-ticket-rules");
        fx.add_change("x", OLD_META);
        fx.write("specseal/changes/x/review.md", &text);
        fx.write(
            "specseal/changes/archive/2026-07-04-old/.meta.yaml",
            "schema: spec-driven\ncreated: 2026-07-01\narchived_at: 2026-07-04\n",
        );
        fx.write("specseal/changes/archive/2026-07-04-old/review.md", &text);

        let live = station_ticket_at(fx.root(), "x", "review").expect("live ticket");
        assert_eq!(live["reviewBaselineSmells"], json!(specseal_core::skills::REVIEW_BASELINE_SMELLS));
        assert_eq!(
            live["rounds"][0]["rules"],
            json!({
                "baseline": "extend",
                "critical": ["所有 SQL 一律用参数化查找，不得用字符串拼接"],
                "warning": [],
                "suggestion": [],
            })
        );
        assert_eq!(live["rounds"][1]["rules"], Value::Null);
        assert_eq!(archived_station_ticket_at(fx.root(), "2026-07-04-old", "review"), Some(live.clone()));
        assert_eq!(ticket_json_from_text("review", &text), Some(live));
    }

    #[test]
    fn ticket_json_from_text_fails_closed_on_degenerate_input() {
        // sharp-edges（Lazy／Confused Developer）：空字符串、只有标题无轮、缺 Scope
        // 的轮、站别大小写不符或空白——皆回 None 不 panic。壳层把远程封存原文
        // 直接喂这里，这些是它会收到的最钝输入。
        assert!(ticket_json_from_text("review", "").is_none());
        assert!(ticket_json_from_text("review", "# Review — x\n").is_none());
        assert!(ticket_json_from_text("review", "## Round 1\n\n- [WARNING] a.rs — no scope line\n").is_none());
        assert!(ticket_json_from_text("Review", TICKET).is_none(), "station token is case-sensitive like the CLI");
        assert!(ticket_json_from_text("", TICKET).is_none());
        assert_eq!(ticket_json_from_text("verify", TICKET).unwrap()["rounds"][0]["index"], 1);
    }

    #[test]
    fn station_ticket_is_none_for_a_non_utf8_ticket_file() {
        // 非 UTF-8 字节的工单档读不成文本 → None（不 panic、不当成空工单），
        // 活变更与封存两条路一致。
        let fx = FixtureRoot::new("q-ticket-bytes");
        fx.add_change("x", OLD_META);
        let live = fx.root().join("specseal").join("changes").join("x").join("review.md");
        std::fs::write(&live, [0x23, 0x20, 0xFF, 0xFE, 0x0A]).unwrap();
        assert!(station_ticket_at(fx.root(), "x", "review").is_none());

        fx.write("specseal/changes/archive/2026-07-04-old/proposal.md", "## Why\n");
        let carried = fx
            .root()
            .join("specseal")
            .join("changes")
            .join("archive")
            .join("2026-07-04-old")
            .join("verify.md");
        std::fs::write(&carried, [0xFF, 0xFE]).unwrap();
        assert!(archived_station_ticket_at(fx.root(), "2026-07-04-old", "verify").is_none());
    }

    #[test]
    fn non_project_yields_empty_state_not_panic() {
        let root = crate::testfixture::fresh_non_project_dir("query");
        // 清单回应的顶层四键在非项目时照样齐全：前端的 ChangeListPayload 四键都是必填。
        assert_eq!(
            list_changes_at(&root),
            json!({ "changes": [], "planError": null, "next": null, "unpromotedCuts": [] })
        );
        assert_eq!(list_specs_at(&root), json!({ "specs": [] }));
        assert!(status_at(&root, "anything").is_err());
        assert!(document_at(&root, "anything", "proposal").is_none());
        assert!(station_ticket_at(&root, "anything", "review").is_none());
    }

    // --- 详情页「打开 ▾」的文档定位（desktop-detail-page design D4）---

    #[test]
    fn document_location_resolves_like_the_reader_in_the_main_checkout() {
        let fx = FixtureRoot::new("q-doc-loc");
        fx.add_change("demo", OLD_META);
        let loc = document_location_at(fx.root(), "demo", "proposal.md").expect("location");
        assert_eq!(loc.relative, "specseal/changes/demo/proposal.md");
        assert!(Path::new(&loc.path).ends_with("specseal/changes/demo/proposal.md"), "{}", loc.path);
        let spec = document_location_at(fx.root(), "demo", "specs/auth/spec.md").expect("spec location");
        assert_eq!(spec.relative, "specseal/changes/demo/specs/auth/spec.md");
    }

    #[test]
    fn document_location_points_into_the_worktree_copy_for_a_mapped_change() {
        // 读文档走 context_for_change（worktree 副本）；打开／显示／拷贝路径必须指向同一份。
        let fx = FixtureRoot::new("q-doc-loc-wt");
        fx.add_change("add-auth", OLD_META);
        let wt = fx.attach_worktree("add-auth");
        let loc = document_location_at(fx.root(), "add-auth", "tasks.md").expect("location");
        assert_eq!(loc.relative, "specseal/changes/add-auth/tasks.md");
        assert!(Path::new(&loc.path).starts_with(wt.path()), "{} 应在 {}", loc.path, wt.path().display());
    }

    #[test]
    fn document_location_rejects_path_traversal() {
        let fx = FixtureRoot::new("q-doc-loc-bad");
        fx.add_change("demo", OLD_META);
        assert!(document_location_at(fx.root(), "../x", "proposal.md").is_none());
        assert!(document_location_at(fx.root(), "demo", "../../secret.md").is_none());
    }

    // --- 规格详情页与已封存详情页的文档定位（desktop-readonly-detail-pages design D7）---

    #[test]
    fn spec_location_resolves_the_canonical_spec_under_the_spec_dir() {
        let fx = FixtureRoot::new("q-spec-loc");
        let loc = spec_location_at(fx.root(), "auth").expect("location");
        assert_eq!(loc.relative, "specseal/specs/auth/spec.md");
        assert!(Path::new(&loc.path).ends_with("specseal/specs/auth/spec.md"), "{}", loc.path);
    }

    #[test]
    fn archived_document_location_resolves_inside_the_dated_archive_dir() {
        let fx = FixtureRoot::new("q-arch-loc");
        let loc = archived_document_location_at(fx.root(), "2026-07-04-old", "proposal.md").expect("location");
        assert_eq!(loc.relative, "specseal/changes/archive/2026-07-04-old/proposal.md");
        let spec = archived_document_location_at(fx.root(), "2026-07-04-old", "specs/auth/spec.md").expect("spec");
        assert_eq!(spec.relative, "specseal/changes/archive/2026-07-04-old/specs/auth/spec.md");
    }

    #[test]
    fn spec_and_archived_locations_reject_path_traversal() {
        let fx = FixtureRoot::new("q-ro-loc-bad");
        assert!(spec_location_at(fx.root(), "../x").is_none());
        assert!(archived_document_location_at(fx.root(), "../x", "proposal.md").is_none());
        assert!(archived_document_location_at(fx.root(), "2026-07-04-old", "../../secret.md").is_none());
    }

    #[test]
    fn spec_and_archived_locations_are_none_outside_a_project() {
        let root = crate::testfixture::fresh_non_project_dir("q-ro-loc");
        assert!(spec_location_at(&root, "auth").is_none());
        assert!(archived_document_location_at(&root, "2026-07-04-old", "proposal.md").is_none());
    }
}
