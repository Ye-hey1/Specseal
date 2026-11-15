//! 无 host workspace 派发（Node host store 的 `workspace: None`）不得让封存的
//! linked worktree 守门改判「行程 cwd」——review Round 1 的 must-fix 重现测试。
//!
//! 这个文件刻意只有一个测试、自成一个测试 binary：它会改行程 cwd
//! （`set_current_dir`），与其他测试同进程并跑会互相污染，单测试 binary 才安全。
//! 情境：store 指向一个与 git 毫无关系的项目，行程 cwd 却恰好在别个 repo 的
//! `specseal/` 分支 linked worktree 内——守门若读 cwd 就会对不相干的 store 误拒。

use std::path::{Path, PathBuf};
use std::process::Command;

use specseal_core::command::{execute, Command as Verb, ExecutionContext};
use specseal_fs::FsStore;

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(cwd).output().expect("run git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_hostless_archive_ignores_the_processes_cwd() {
    let base = std::env::temp_dir().join(format!("specseal-fs-hostless-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);

    // 与 git 无关的 store 项目：一个零任务、有效 meta 的 change `demo`。
    let project = base.join("project");
    let change = project.join("openspec").join("changes").join("demo");
    std::fs::create_dir_all(&change).unwrap();
    std::fs::write(change.join(".openspec.yaml"), "schema: spec-driven\ncreated: 2026-07-01\n")
        .unwrap();
    std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();

    // 别处的 git repo ＋ specseal/ 分支的 linked worktree，行程 cwd 移进去。
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(repo.join("README.md"), "scratch\n").unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "Sandbox Tester"]);
    git(&repo, &["config", "user.email", "sandbox@example.com"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let worktree: PathBuf = base.join("repo.worktrees").join("x");
    git(&repo, &["worktree", "add", "-q", "-b", "specseal/x", worktree.to_str().unwrap()]);
    std::env::set_current_dir(&worktree).expect("enter the linked worktree");

    let store = FsStore::new(&project, "openspec");
    let result = execute(
        &store,
        &ExecutionContext::default(),
        Verb::Archive {
            change: Some("demo".to_string()),
            skip_specs: true,
            no_validate: true,
            mark_tasks_complete: false,
            carry_review: false,
            carry_verify: false,
        },
    );

    assert!(
        result.is_ok(),
        "a hostless dispatch has no local environment to judge — the cwd's worktree \
         must not refuse an unrelated store's archive: {:?}",
        result.err()
    );
    assert!(
        !change.exists(),
        "the store's active change moved into its archive"
    );

    std::env::set_current_dir(std::env::temp_dir()).unwrap();
    let _ = std::fs::remove_dir_all(&base);
}
