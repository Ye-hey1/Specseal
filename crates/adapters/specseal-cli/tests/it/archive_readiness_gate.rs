//! `specseal archive` 单笔封存的两道环境／状态守门 — fs 模式契约
//! (change-lifecycle spec「单笔封存的任务完成度守门」与「封存的 linked
//! worktree 环境守门」)。
//!
//! 任务未完成(总数>0 且未全勾)的单笔封存拒绝:非零 exit code、stderr 载明
//! N/M 证据与两条出路、零文件效果。--mark-tasks-complete 维持既有语意:
//! 先全勾再封存。成功路径(全完成/0 任务/批量)的既有测试不在此档、不修改。
//!
//! linked worktree 守门走真实 git repo ＋ `git worktree add`:`.git` 是文件
//! 这个判准无法以捏造文件取代(分支事实仍得由 git 回报)。主 checkout 的行为
//! 不变由本档上半部与 archive_merge_gate／archive_evidence_gate 的既有绿灯确认。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
/// 新开 capability 的 delta 自带合格 Purpose——缺席会被封存的 Purpose 守门挡下
/// （spec archive-merge「新 capability 的 Purpose 自 delta 带入」）。
const DELTA_SPEC: &str = "## Purpose\n\n本 capability 是测试用的示范能力，涵盖一个可观察行为与其成功路径，供封存流程的守门测试取用。\n\n## ADDED Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// Throwaway project: one structurally valid change `demo` (proposal +
    /// delta spec + the given tasks.md), no git — @trace probes fail soft.
    fn new(tag: &str, tasks_md: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-archive-gate-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(change.join("specs").join("demo-cap")).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), tasks_md).unwrap();
        std::fs::write(change.join("specs").join("demo-cap").join("spec.md"), DELTA_SPEC).unwrap();
        TempProject { dir }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(args)
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .output()
            .expect("run specseal binary")
    }

    fn archive_dir(&self) -> PathBuf {
        self.dir.join("specseal").join("changes").join("archive")
    }

    /// The dated archived change directory (`<date>-demo`), if any.
    fn archived_demo(&self) -> Option<PathBuf> {
        let entries = std::fs::read_dir(self.archive_dir()).ok()?;
        entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with("-demo")))
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn incomplete_change_refuses_with_evidence_and_no_archive_dir() {
    // spec scenario「任务未完成的单笔封存被拒」:3 任务 1 勾 → 非零 exit,
    // stderr 载明 1/3 与两条出路,changes/archive/ 无新目录、change 原地不动。
    let p = TempProject::new("refuse", "- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n");
    let out = p.run(&["archive", "demo"]);
    assert!(!out.status.success(), "incomplete change must refuse archive");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("1/3"), "evidence N/M on stderr: {stderr}");
    assert!(stderr.contains("--mark-tasks-complete"), "exit route named: {stderr}");
    assert!(p.archived_demo().is_none(), "no archived directory appears");
    assert!(
        p.dir.join("specseal").join("changes").join("demo").join("tasks.md").is_file(),
        "change stays in place"
    );
    let tasks =
        std::fs::read_to_string(p.dir.join("specseal").join("changes").join("demo").join("tasks.md"))
            .unwrap();
    assert_eq!(tasks, "- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n", "tasks.md byte-identical");
}

#[test]
fn mark_tasks_complete_archives_and_checks_every_task() {
    // spec scenario「--mark-tasks-complete 放行并先全勾」:exit 0,封存后的
    // tasks.md 全部任务为已勾,active change 目录消失。
    let p = TempProject::new("mark", "- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n");
    let out = p.run(&["archive", "demo", "--mark-tasks-complete"]);
    assert!(
        out.status.success(),
        "mark-tasks-complete must archive: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !p.dir.join("specseal").join("changes").join("demo").exists(),
        "active change moved into the archive"
    );
    let archived = p.archived_demo().expect("dated archive directory exists");
    let tasks = std::fs::read_to_string(archived.join("tasks.md")).unwrap();
    assert!(!tasks.contains("- [ ]"), "every task checked after archive: {tasks}");
    assert_eq!(tasks.matches("- [x]").count(), 3, "all three tasks present and checked: {tasks}");
    // spec「封存写入 archived_at」：封存目录 metadata 有一行 RFC 3339 的 archived_at，
    // 日期与目录名前缀相同。
    let meta = std::fs::read_to_string(archived.join(".meta.yaml")).unwrap();
    let stamps: Vec<&str> = meta.lines().filter_map(|l| l.strip_prefix("archived_at: ")).collect();
    assert_eq!(stamps.len(), 1, "one archived_at line: {meta}");
    assert!(chrono::DateTime::parse_from_rfc3339(stamps[0]).is_ok(), "RFC 3339: {meta}");
    let dir_name = archived.file_name().unwrap().to_str().unwrap();
    assert_eq!(&stamps[0][..10], &dir_name[..10], "same instant as the dated name: {meta}");
}

#[test]
fn archiving_a_change_without_metadata_creates_none() {
    // spec「封存写入 archived_at」：没有 `.meta.yaml` 的旧式 change 照常封存，
    // 不为了 archived_at 新建一份 metadata。
    let p = TempProject::new("no-meta", "- [x] 1.1 a\n");
    std::fs::remove_file(p.dir.join("specseal").join("changes").join("demo").join(".meta.yaml"))
        .unwrap();
    let out = p.run(&["archive", "demo"]);
    assert!(out.status.success(), "a meta-less change archives: {}", String::from_utf8_lossy(&out.stderr));
    let archived = p.archived_demo().expect("dated archive directory exists");
    assert!(!archived.join(".meta.yaml").exists(), "no metadata is created for archived_at");
}

/// 真实 git repo ＋ sibling linked worktree 的沙盒。change `demo` 的 tasks.md
/// 由调用端给定:全勾时任何拒绝都只可能来自环境守门,不会与完成度守门混淆。
struct GitProject {
    root: PathBuf,
    repo: PathBuf,
}

impl GitProject {
    fn new(tag: &str, tasks_md: &str) -> GitProject {
        let root = std::env::temp_dir()
            .join(format!("specseal-cli-archive-worktree-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();

        let p = GitProject { root, repo };
        p.add_change("demo", tasks_md);
        p.git(&["init", "-q", "-b", "main"]);
        p.git(&["config", "user.name", "Sandbox Tester"]);
        p.git(&["config", "user.email", "sandbox@example.com"]);
        // Windows 的 git 缺省 core.autocrlf=true,`git worktree add` 会在 checkout
        // 时把 LF 换成 CRLF——沙盒里的 tasks.md 于是与写进去的比特不同,逐比特
        // 比对(前置写入未发生)便会误红。沙盒的行尾由测试自己决定,不随机器的
        // git 设置漂移。
        p.git(&["config", "core.autocrlf", "false"]);
        p.git(&["add", "-A"]);
        p.git(&["commit", "-q", "-m", "init"]);
        p
    }

    /// 再写一个结构完整的 change(未提交)。worktree 内要看得到的话,调用端得
    /// 自行 git add ＋ commit —— `git worktree add` 只带得走已提交的内容。每个
    /// change 各配一个 capability,同一沙盒里连续封存两笔才不会撞正典。
    fn add_change(&self, name: &str, tasks_md: &str) {
        let change = self.repo.join("specseal").join("changes").join(name);
        std::fs::create_dir_all(change.join("specs").join(format!("{name}-cap"))).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), tasks_md).unwrap();
        std::fs::write(
            change.join("specs").join(format!("{name}-cap")).join("spec.md"),
            DELTA_SPEC,
        )
        .unwrap();
    }

    /// 封存后的日期目录(`<date>-<name>`)是否已出现在 repo 本体(比照
    /// `TempProject::archived_demo`,多带 change 名以支持同沙盒两笔)。
    fn archived(&self, name: &str) -> bool {
        let Ok(entries) = std::fs::read_dir(self.repo.join("specseal").join("changes").join("archive"))
        else {
            return false;
        };
        entries
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(&format!("-{name}")))
    }

    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(&self.repo)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 在 sibling 巢创建指定分支的 linked worktree(其 `.git` 为文件)。
    fn add_worktree(&self, dir: &str, branch: &str) -> PathBuf {
        let path = self.root.join("repo.worktrees").join(dir);
        self.git(&["worktree", "add", "-q", "-b", branch, path.to_str().expect("utf-8 path")]);
        path
    }

    fn run_in(&self, cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(args).current_dir(cwd);
        for key in ["SPECSEAL_STORE_URL", "SPECSEAL_TOKEN", "NO_COLOR"] {
            cmd.env_remove(key);
        }
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd.output().expect("run specseal binary")
    }
}

impl Drop for GitProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn archive_inside_a_specseal_worktree_refuses_with_zero_file_effects() {
    // spec scenario「worktree 内封存被拒且零文件效果」:非零 exit,stderr 同时
    // 带 worktree 事实与 worktree-merge 指路,change 原地不动、正典无写入、
    // 解封存备份目录不生成。
    let p = GitProject::new("refuse", "- [x] 1.1 a\n");
    let wt = p.add_worktree("demo", "specseal/demo");

    let out = p.run_in(&wt, &["archive", "demo"], &[("NO_COLOR", "1")]);
    assert!(!out.status.success(), "archiving inside a linked worktree must refuse");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("worktree"), "worktree fact on stderr: {stderr}");
    assert!(stderr.contains("worktree-merge"), "worktree-merge route named: {stderr}");
    assert!(
        wt.join("specseal").join("changes").join("demo").join("tasks.md").is_file(),
        "change stays in place"
    );
    assert!(
        !wt.join("specseal").join("changes").join("archive").exists(),
        "no archive directory appears"
    );
    assert!(
        !wt.join("specseal").join("specs").exists(),
        "no canonical spec is written"
    );
    assert!(!wt.join(".specseal").join("snapshots").exists(), "no unarchive backup is written");
}

#[test]
fn archive_inside_a_non_specseal_branch_worktree_behaves_like_a_main_checkout() {
    // spec scenario「非 specseal 分支的 worktree 放行」:`.git` 同样是文件,
    // 但分支不合惯例 → 封存照常成功。
    let p = GitProject::new("passthrough", "- [x] 1.1 a\n");
    let wt = p.add_worktree("feature", "feature/anything");

    let out = p.run_in(&wt, &["archive", "demo"], &[("NO_COLOR", "1")]);
    assert!(
        out.status.success(),
        "a non-specseal branch must archive: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !wt.join("specseal").join("changes").join("demo").exists(),
        "active change moved into the archive"
    );
}

#[test]
fn archive_inside_a_worktree_without_git_fails_open() {
    // spec scenario「git 不可用时 fail-open」:PATH 清空后分支事实取不到,
    // 守门放行——无 git 的环境不得因此永远无法封存。
    let p = GitProject::new("no-git", "- [x] 1.1 a\n");
    let wt = p.add_worktree("demo", "specseal/demo");

    let out = p.run_in(&wt, &["archive", "demo"], &[("NO_COLOR", "1"), ("PATH", "")]);
    assert!(
        out.status.success(),
        "git being unavailable must not block archive: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !wt.join("specseal").join("changes").join("demo").exists(),
        "active change moved into the archive"
    );
}

#[test]
fn archive_from_a_main_checkout_on_a_specseal_branch_passes_through() {
    // spec scenario「主 checkout 零额外开销」的反向案例:`.git` 是目录,分支名
    // 却恰为 specseal/demo。两次运行分工明确——
    //  (a) git 正常可用:守门的 fs 短路若被拿掉,分支事实取得到就会误拒,这是
    //      本测试的红灯来源;
    //  (b) PATH 清空:主 checkout 路径完全不依赖 git。
    // 两者不能并成一次:守门 fail-open,PATH 清空时分支必然取不到,单靠清空
    // PATH 观察不到 fs 短路还在不在。
    let p = GitProject::new("main-checkout", "- [x] 1.1 a\n");
    p.add_change("demo2", "- [x] 1.1 a\n");
    p.git(&["checkout", "-q", "-b", "specseal/demo"]);

    let out = p.run_in(&p.repo, &["archive", "demo"], &[("NO_COLOR", "1")]);
    assert!(
        out.status.success(),
        "a main checkout must archive even on a specseal/ branch: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !p.repo.join("specseal").join("changes").join("demo").exists(),
        "active change moved into the archive"
    );
    assert!(p.archived("demo"), "dated archive directory for demo exists");

    let out = p.run_in(&p.repo, &["archive", "demo2"], &[("NO_COLOR", "1"), ("PATH", "")]);
    assert!(
        out.status.success(),
        "a main checkout must not depend on git: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(p.archived("demo2"), "dated archive directory for demo2 exists");
}

#[test]
fn refused_archive_leaves_the_mark_tasks_complete_pre_write_undone() {
    // spec scenario「拒绝时 --mark-tasks-complete 前置写入零效果」:守门排在
    // 前置全勾写入之前,被拒的封存不得留下一份已被全勾的 tasks.md。守门若被
    // 挪到前置写入之后,exit code 依旧非零,只有这份逐比特比对会转红。
    const TASKS: &str = "- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n";
    let p = GitProject::new("pre-write", TASKS);
    let wt = p.add_worktree("demo", "specseal/demo");

    let out = p.run_in(&wt, &["archive", "demo", "--mark-tasks-complete"], &[("NO_COLOR", "1")]);
    assert!(!out.status.success(), "archiving inside a linked worktree must refuse");
    // 钉住拒绝来源:TASKS 本来就 1/3,若旗标失效改由完成度守门拒绝,exit 同样
    // 非零、tasks.md 同样不动——只有这句能分辨拒绝真的来自 worktree 守门。
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("worktree-merge"), "the worktree gate did the refusing: {stderr}");
    let tasks =
        std::fs::read_to_string(wt.join("specseal").join("changes").join("demo").join("tasks.md"))
            .unwrap();
    assert_eq!(tasks, TASKS, "tasks.md byte-identical — the pre-write never happened");
}

#[test]
fn bulk_archive_inside_a_specseal_worktree_refuses_too() {
    // spec scenario「bulk 封存同受守门」:多个 change 名即 bulk 路径。输出去向
    // 是契约——中止报告(含守门全文)走 stdout,bulk 失败摘要走 stderr,分流断言。
    let p = GitProject::new("bulk", "- [x] 1.1 a\n");
    p.add_change("demo2", "- [x] 1.1 a\n");
    p.git(&["add", "-A"]);
    p.git(&["commit", "-q", "-m", "add demo2"]);
    let wt = p.add_worktree("demo", "specseal/demo");

    let out = p.run_in(&wt, &["archive", "demo", "demo2"], &[("NO_COLOR", "1")]);
    assert!(!out.status.success(), "bulk archive inside a linked worktree must refuse");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // 中止报告只有 bulk 路径会印:少了这句,多 change 名若被改回单笔路径,
    // 后面的断言仍会绿,bulk 就悄悄失去覆盖。
    assert!(stdout.contains("Bulk archive aborted at 'demo'"), "the bulk path ran: {stdout}");
    // "linked worktree" 而非裸 "worktree":fixture 路径 repo.worktrees/ 本身
    // 就含后者,裸字比对零信息。
    assert!(stdout.contains("linked worktree"), "worktree fact on stdout: {stdout}");
    assert!(stdout.contains("worktree-merge"), "worktree-merge route on stdout: {stdout}");
    assert!(stderr.contains("bulk archive failed at 'demo'"), "bulk summary on stderr: {stderr}");
    for name in ["demo", "demo2"] {
        assert!(
            wt.join("specseal").join("changes").join(name).join("tasks.md").is_file(),
            "{name} stays in place"
        );
    }
    assert!(
        !wt.join("specseal").join("changes").join("archive").exists(),
        "no archive directory appears"
    );
    assert!(!wt.join("specseal").join("specs").exists(), "no canonical spec is written");
    assert!(!wt.join(".specseal").join("snapshots").exists(), "no unarchive backup is written");
}
