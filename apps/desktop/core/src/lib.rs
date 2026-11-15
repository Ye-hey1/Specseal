//! specseal-desktop-core — 桌面 app 的纯逻辑层。
//!
//! Tauri 壳（specseal-desktop）以 #[tauri::command] 薄包装本 crate 的函数。
//! 本 crate 只依赖 specseal-core 与 specseal-fs，不依赖 Tauri，故可独立 `cargo test`。

use std::path::Path;

use specseal_core::workspace::Workspace;
use specseal_fs::FsStore;

pub mod cache;
pub mod discussions;
pub mod fs_actions;
pub mod manage;
pub mod manual;
pub mod project;
pub mod query;
pub mod search;
pub mod settings;
#[cfg(test)]
pub(crate) mod testfixture;
pub mod trackpad_gesture;
pub mod tray_panel;
pub mod verbs;

/// 桌面 app 对单一本地 openspec/ 项目的运行语境：探索到的 workspace ＋ 其 fs store。
pub struct ProjectContext {
    pub workspace: Workspace,
    pub store: FsStore,
}

/// 自 `root` 起向上探索 specseal 项目；找到则建构 [`ProjectContext`]，否则回传 `None`
/// （非 specseal 项目目录；坏 `.specseal.yaml` 依引擎 fail-closed 同样视为建构
/// 失败——Phase 3 WorkspaceSession 收编时再浮出错误细节）。不 spawn CLI、不移动
/// 任何文档真相。
pub fn init_core_context(root: &Path) -> Option<ProjectContext> {
    let workspace = Workspace::discover(root).ok().flatten()?;
    let store = FsStore::new(&workspace.root, &workspace.spec_dir_name);
    Some(ProjectContext { workspace, store })
}

/// 现取 worktree 观察面（design D4：每次现取、不缓存）。env 读取惯例的唯一落点。
pub(crate) fn facts_for(ctx: &ProjectContext) -> specseal_host::worktree::WorktreeFacts {
    specseal_host::worktree::observed_facts(&ctx.workspace, &ctx.store, |key| {
        std::env::var(key).ok()
    })
}

/// 「这个 change 该读／写哪个根」的唯一裁决：有映射且副本仍持有该 change 目录
/// → 该 worktree 根；否则 `None`（＝主 checkout）。存在性检查与
/// `WorktreeOverlay::of` 的回退同步——facts 取得后、使用前副本被移除的竞态
/// 窗口内，整组读写一起回主 checkout，不出现半套视图。
pub(crate) fn worktree_root_for<'a>(
    ctx: &ProjectContext,
    facts: &'a specseal_host::worktree::WorktreeFacts,
    change: &str,
) -> Option<&'a Path> {
    facts
        .get(change)
        .filter(|e| {
            e.path.join(&ctx.workspace.spec_dir_name).join("changes").join(change).is_dir()
        })
        .map(|e| e.path.as_path())
}

/// 某 change 的所在 store：有映射为其 worktree 副本、否则为主 checkout
/// （[`worktree_root_for`] 的裁决）。给手上已有 facts、一次要处理多个 change 的调用端
/// （拖排整栏补章、前置写入后的 overlay 复检），一次 git spawn 服务全部；只处理单一
/// change 的动词走 [`require_context_for_change`]。
pub(crate) fn home_store_for(
    ctx: &ProjectContext,
    facts: &specseal_host::worktree::WorktreeFacts,
    change: &str,
) -> FsStore {
    let root = worktree_root_for(ctx, facts, change).unwrap_or(ctx.workspace.root.as_path());
    FsStore::new(root, &ctx.workspace.spec_dir_name)
}

/// 单一 change 的运行语境（design D1）：该 change 有 worktree 映射时，以那份
/// worktree 副本为根建构 [`ProjectContext`]；否则沿用主 checkout。
///
/// worktree 是完整 checkout，Workspace 与 store 在其中天然成立，因此读与写共用
/// 同一机制：任务完成的侧效（touched 记录、git 脏档归因、head commit、开工章）
/// 随定根一并落在 worktree 内。每次调用现取 observed_facts、不缓存——映射条件
/// 已含「worktree 内 change 目录可读」，文件夹被移除的下一次调用自然回读主
/// checkout，没有 stale 窗口。政策关、非主 checkout、git 不可用时 facts 为空，
/// 回传的就是主 checkout context（行为与本函数出现前完全相同）。
pub(crate) fn context_for_change(root: &Path, change: &str) -> Option<ProjectContext> {
    let ctx = init_core_context(root)?;
    let facts = facts_for(&ctx);
    match worktree_root_for(&ctx, &facts, change) {
        // 以 worktree 路径＋主 checkout 的 spec 目录名直接建构（与 overlay 的
        // 组装同款），不走 discovery——向上探索在极端情境会走出 worktree、落到
        // 祖先目录的别的项目。
        Some(wt_root) => {
            let workspace = Workspace {
                root: wt_root.to_path_buf(),
                spec_dir_name: ctx.workspace.spec_dir_name.clone(),
            };
            let store = FsStore::new(&workspace.root, &workspace.spec_dir_name);
            Some(ProjectContext { workspace, store })
        }
        None => Some(ctx),
    }
}

/// [`context_for_change`] 的必得版：非 specseal 项目时回统一错误消息——
/// 动词层（verbs.rs 与 manage.rs 的写入动词）共用的唯一转译。
pub(crate) fn require_context_for_change(
    root: &Path,
    change: &str,
) -> Result<ProjectContext, String> {
    context_for_change(root, change)
        .ok_or_else(|| format!("not a specseal project: {}", root.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use specseal_core::store::Store;
    use std::path::PathBuf;

    /// 本 crate 位于 <repo>/apps/desktop/core，故 repo 根为 manifest 的上三层。
    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
    }

    #[test]
    fn init_core_context_on_project_root_discovers_workspace() {
        let ctx = init_core_context(&repo_root()).expect("should discover the specseal project");
        assert!(
            ctx.workspace.spec_dir().join("changes").exists(),
            "discovered workspace should expose the openspec changes dir"
        );
        // 不得 panic：验证内嵌 core 可读取本地文档。
        let _ = ctx.store.list_changes();
    }

    #[test]
    fn init_core_context_on_non_project_returns_none() {
        assert!(
            init_core_context(&crate::testfixture::fresh_non_project_dir("lib")).is_none(),
            "a non-specseal directory should yield no project context"
        );
    }

    #[test]
    fn worktree_root_resolution_falls_back_when_the_copy_is_gone() {
        // 审查 finding（Round 1）：读根解析要与 overlay 的存在性回退同步——facts
        // 取得后、使用前 worktree 被移除的竞态窗口内，解析须回主 checkout，
        // 不得回传指向已消失路径的根（指纹锚才不会误判 Stale）。
        let fx = crate::testfixture::FixtureRoot::new("lib-root-gone");
        fx.add_change("add-auth", "schema: spec-driven\ncreated: 2026-07-01\n");
        let ctx = init_core_context(fx.root()).expect("project context");
        let mut facts = specseal_host::worktree::WorktreeFacts::new();
        facts.insert(
            "add-auth".to_string(),
            specseal_host::worktree::WorktreeEntry {
                path: fx.root().join("no-such-worktree"),
                branch: "specseal/add-auth".to_string(),
            },
        );
        assert!(
            worktree_root_for(&ctx, &facts, "add-auth").is_none(),
            "消失的副本须回退主 checkout"
        );
        assert!(worktree_root_for(&ctx, &facts, "other").is_none(), "无映射本就回主 checkout");
    }
}
