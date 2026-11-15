//! 测试共用的暂存项目 fixture：真实 specseal/ 目录布局（旧布局 openspec/ 见
//! [`FixtureRoot::legacy`]），测试结束自动清除。
//! 取代早期直接指向本 repo 的自参照 fixture——repo 内容会随 change 归档而变，
//! 自参照测试会无声腐化（desktop-shell-and-browser 归档后即断）。

use std::path::{Path, PathBuf};

pub(crate) struct FixtureRoot(PathBuf);

/// [`FixtureRoot::attach_worktree`] 创建的 worktree 副本：路径带着往 change
/// 目录的导航，测试不再以裸 `PathBuf` 流转、逐处手拼 `specseal/changes/<名>`。
pub(crate) struct WorktreeCopy(PathBuf);

impl WorktreeCopy {
    /// worktree 根（git 回报的范式路径）。
    pub fn path(&self) -> &Path {
        &self.0
    }

    /// 一个 change 在这份副本内的目录——写入「只存在于 worktree」的内容用。
    pub fn change_dir(&self, change: &str) -> PathBuf {
        self.0.join("specseal").join("changes").join(change)
    }
}

impl FixtureRoot {
    pub fn new(tag: &str) -> FixtureRoot {
        FixtureRoot::with_spec_dir(tag, "specseal")
    }

    /// 旧布局（openspec/）的项目：只给验证旧布局、导入与迁移的测试用。
    pub fn legacy(tag: &str) -> FixtureRoot {
        FixtureRoot::with_spec_dir(tag, "openspec")
    }

    fn with_spec_dir(tag: &str, spec_dir: &str) -> FixtureRoot {
        let dir = std::env::temp_dir().join(format!(
            "specseal-dtcore-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(spec_dir).join("changes")).unwrap();
        FixtureRoot(dir)
    }

    pub fn root(&self) -> &Path {
        &self.0
    }

    pub fn write(&self, rel: &str, content: &str) {
        let path = self.0.join(rel.split('/').collect::<PathBuf>());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
    }

    /// 主 checkout ＋ 一个 specseal/<change> worktree，change 两份副本皆在——
    /// 探索成立映射的三个条件。
    ///
    /// 调用前写入的文件都会进 seed commit，因此也存在于 worktree 副本；之后两边
    /// 各自改档即可制造「主 checkout 与 worktree 相异」的情境。
    pub fn attach_worktree(&self, change: &str) -> WorktreeCopy {
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(self.root())
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.test")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.test")
                .output()
                .expect("run git");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        self.write(".specseal.yaml", "tools:\n  - claude\n");
        self.write("specseal/config.yaml", "schema: spec-driven\nworktree: true\n");
        git(&["init", "-q", "-b", "main"]);
        git(&["add", "-A"]);
        git(&["commit", "-qm", "seed"]);
        let wt = self.0.join("wt");
        git(&["worktree", "add", "-q", "-b", &format!("specseal/{change}"), wt.to_str().unwrap()]);
        // 期望值与产品同源：产品逐字取 `git worktree list --porcelain` 的路径，这里
        // 也拿 git 回报的拼法。自行 canonicalize 逼近不了——macOS 它解 /var symlink
        // 刚好一致，Windows 却会加上 \\?\ 前缀，而 git 回报的是正斜线＋8.3 短名
        // （RUNNER~1）展开后的长名，两种拼法指同一目录仍对不上。
        let out = std::process::Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(self.root())
            .output()
            .expect("git worktree list");
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let reported = text
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .next_back()
            .expect("porcelain lists the new worktree");
        WorktreeCopy(PathBuf::from(reported))
    }

    /// 建一个含 proposal 与 tasks 的 change；meta 原文由调用端给（测 started_* 叠加）。
    pub fn add_change(&self, name: &str, meta: &str) {
        self.write(&format!("specseal/changes/{name}/.meta.yaml"), meta);
        self.write(
            &format!("specseal/changes/{name}/proposal.md"),
            "## Why\n\nDemo change.\n\n## What Changes\n\n- something\n",
        );
        self.write(
            &format!("specseal/changes/{name}/tasks.md"),
            "## 1. Group\n\n- [ ] 1.1 First task\n- [x] 1.2 Second task\n",
        );
    }
}

/// 看板显示序的 change 名（走 `list_changes_at` 的清单 payload）——query 与 manage
/// 两边的顺序断言共用。
pub(crate) fn board_names(root: &Path) -> Vec<String> {
    crate::query::list_changes_at(root)["changes"]
        .as_array()
        .expect("changes array")
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_string())
        .collect()
}

/// 非 specseal 项目的空暂存目录（向上探索找不到规格文件夹的情境）。
pub(crate) fn fresh_non_project_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("specseal-dtcore-nonproject-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
