//! `specseal list` 的 worktree 观察面（worktree-overlay spec）——真实 git repo
//! ＋ `git worktree add` 的端到端情境。
//!
//! 两条输出路径都是契约：`--json` 的可空 worktree 字段与人眼行尾的固定字面
//! 「 [worktree]」。政策关闭、非主 checkout、分支不合惯例三种情形下输出必须与
//! 本能力导入前逐比特一致——回归对照就是同一颗二进位在政策关闭时的输出。
//!
//! 路径断言一律先范式（macOS 的 /var 是 /private/var 的 symlink，Windows 的
//! 分隔符与盘符亦不可假设），因此比对 `Path` 而非字符串。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-07-01\n";
const TASKS: &str = "## 1. Group\n\n- [ ] 1.1 first\n- [ ] 1.2 second\n";
const PROPOSAL: &str = "## Why\n\nDemo change.\n";

/// 主 checkout ＋（可选）一个 linked worktree 的沙盒。
struct Fixture {
    root: PathBuf,
    repo: PathBuf,
}

impl Fixture {
    /// 建一个含单一 change `add-dark-mode` 的 git repo。`worktree_policy` 决定
    /// `specseal/config.yaml` 是否写入 `worktree: true`。
    fn new(tag: &str, worktree_policy: bool) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "specseal-cli-worktree-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let change = repo.join("specseal").join("changes").join("add-dark-mode");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(repo.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        let config = if worktree_policy {
            "schema: spec-driven\nworktree: true\n"
        } else {
            "schema: spec-driven\n"
        };
        std::fs::write(repo.join("specseal").join("config.yaml"), config).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("tasks.md"), TASKS).unwrap();
        std::fs::write(change.join("proposal.md"), PROPOSAL).unwrap();

        let f = Fixture { root, repo };
        f.git(&["init", "-q", "-b", "main"]);
        f.git(&["config", "user.name", "Sandbox Tester"]);
        f.git(&["config", "user.email", "sandbox@example.com"]);
        // Windows 的 git 缺省 core.autocrlf=true，`git worktree add` 会在 checkout
        // 时把 LF 换成 CRLF——worktree 副本的 .meta.yaml 于是与 META 的比特
        // 不同，引擎沿用各行行尾写回后，拿 LF 字面逐比特比对便会误红。沙盒的
        // 行尾由测试自己决定，不随机器的 git 设置漂移。
        f.git(&["config", "core.autocrlf", "false"]);
        f.git(&["add", "-A"]);
        f.git(&["commit", "-q", "-m", "init"]);
        f
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

    /// 以惯例分支 `specseal/<change>` 在 sibling 巢创建 worktree，回传其路径。
    fn add_worktree(&self, change: &str) -> PathBuf {
        let path = self.root.join("repo.worktrees").join(change);
        let branch = format!("specseal/{change}");
        self.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            &branch,
            path.to_str().expect("utf-8 path"),
        ]);
        path
    }

    /// 非惯例分支的 worktree。
    fn add_worktree_on_branch(&self, dir: &str, branch: &str) -> PathBuf {
        let path = self.root.join("repo.worktrees").join(dir);
        self.git(&["worktree", "add", "-q", "-b", branch, path.to_str().unwrap()]);
        path
    }

    fn remove_worktree(&self, path: &Path) {
        self.git(&["worktree", "remove", "--force", path.to_str().unwrap()]);
    }

    /// 于指定目录运行 specseal（环境变量一律清干净，避免宿主设置渗入）。
    fn run_in(&self, cwd: &Path, args: &[&str]) -> Output {
        self.run_in_env(cwd, args, &[("NO_COLOR", "1")])
    }

    /// 同上，但由调用端决定色彩相关环境变量——测试 stdout 恒为 pipe，`is_terminal()`
    /// 本就关色，所以「有色路径」必须以 CLICOLOR_FORCE 明确逼出来，否则两趟其实
    /// 跑的是同一条无色路径。
    fn run_in_env(&self, cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(args).current_dir(cwd);
        for key in [
            "SPECSEAL_LOCALE",
            "SPECSEAL_SPEC_LOCALE",
            "SPECSEAL_TDD",
            "SPECSEAL_AUDIT",
            "SPECSEAL_WORKTREE",
            "SPECSEAL_STORE_URL",
            "SPECSEAL_TOKEN",
            "NO_COLOR",
            "CLICOLOR",
            "CLICOLOR_FORCE",
        ] {
            cmd.env_remove(key);
        }
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd.output().expect("run specseal binary")
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_in(&self.repo.clone(), args)
    }

    /// 逼出有色路径（CLICOLOR_FORCE 覆写 NO_COLOR；`--no-color` 旗标仍胜过它）。
    fn run_colored(&self, args: &[&str]) -> Output {
        self.run_in_env(&self.repo.clone(), args, &[("CLICOLOR_FORCE", "1")])
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// `list --json` text without its `modifiedAt` lines: that time belongs to the
/// files, and two projects (or one project before and after a write) never
/// share it.
fn without_modified_at(text: &str) -> String {
    text.lines().filter(|line| !line.trim_start().starts_with("\"modifiedAt\"")).collect::<Vec<_>>().join("\n")
}

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn json_of(out: &Output) -> serde_json::Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!("stdout is JSON ({e}): {}", stdout_of(out));
    })
}

/// `list --json` 的第一个 change 条目。
fn first_change(out: &Output) -> serde_json::Value {
    json_of(out)["changes"][0].clone()
}

/// 勾掉一个 worktree 副本内的任务（不经 CLI，直接改档——测的是读取面）。
fn check_one_task(worktree: &Path) {
    let tasks = worktree
        .join("specseal")
        .join("changes")
        .join("add-dark-mode")
        .join("tasks.md");
    let text = std::fs::read_to_string(&tasks).unwrap();
    std::fs::write(&tasks, text.replacen("- [ ] 1.1", "- [x] 1.1", 1)).unwrap();
}

/// 路径比对用的范式：symlink 展开后比 `Path`，不比字符串（跨平台）。
fn same_path(a: &str, b: &Path) -> bool {
    let norm = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    norm(Path::new(a)) == norm(b)
}

#[test]
fn mapped_change_reports_the_worktree_field_and_the_worktree_task_counts() {
    // Spec scenario 映射成立 ＋ 任务计数即时反映 worktree 副本.
    let f = Fixture::new("mapped", true);
    let wt = f.add_worktree("add-dark-mode");
    check_one_task(&wt);

    let out = f.run(&["list", "--json"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let item = first_change(&out);
    assert_eq!(item["name"], "add-dark-mode");
    assert_eq!(item["completedTasks"], 1, "主副本仍是 0/2，值来自 worktree: {item}");
    assert_eq!(item["totalTasks"], 2);
    let worktree = &item["worktree"];
    assert_eq!(worktree["branch"], "specseal/add-dark-mode", "got: {item}");
    assert!(
        same_path(worktree["path"].as_str().expect("path string"), &wt),
        "worktree path points at the linked worktree: {item}"
    );
}

#[test]
fn mapped_change_line_carries_the_fixed_worktree_marker() {
    // Spec scenario 人眼输出的标示（--no-color 同字面）——两趟必须真的走不同
    // 色彩路径，否则「两者字面一致」等于没被验证。
    let f = Fixture::new("marker", true);
    f.add_worktree("add-dark-mode");

    let line_of = |out: &Output| {
        assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
        let text = stdout_of(out);
        text.lines()
            .find(|l| l.contains("add-dark-mode"))
            .map(str::to_string)
            .unwrap_or_else(|| panic!("no change line in: {text:?}"))
    };

    let colored = line_of(&f.run_colored(&["list"]));
    let plain = line_of(&f.run_colored(&["list", "--no-color"]));
    assert!(colored.contains('\u{1b}'), "the colored run must actually emit ANSI: {colored:?}");
    assert!(!plain.contains('\u{1b}'), "--no-color must win over CLICOLOR_FORCE: {plain:?}");
    assert!(colored.ends_with(" [worktree]"), "got: {colored:?}");
    assert!(plain.ends_with(" [worktree]"), "got: {plain:?}");
}

#[test]
fn removing_the_worktree_restores_the_main_copy_view() {
    // Spec scenario worktree 移除后还原.
    let f = Fixture::new("removed", true);
    let wt = f.add_worktree("add-dark-mode");
    check_one_task(&wt);
    assert_eq!(first_change(&f.run(&["list", "--json"]))["completedTasks"], 1);

    f.remove_worktree(&wt);
    let item = first_change(&f.run(&["list", "--json"]));
    assert!(item.get("worktree").is_none(), "字段消失: {item}");
    assert_eq!(item["completedTasks"], 0, "数值回读主副本: {item}");
    let text = stdout_of(&f.run(&["list"]));
    assert!(!text.contains("[worktree]"), "标示不残留: {text:?}");
}

#[test]
fn policy_off_never_overlays_and_leaves_both_outputs_untouched() {
    // Spec scenario 政策关闭时零介入：同一颗二进位、同一份内容，仅政策开关不同。
    let off = Fixture::new("policy-off", false);
    let wt = off.add_worktree("add-dark-mode");
    check_one_task(&wt);

    let bare = Fixture::new("policy-off-bare", false);

    // 两个项目各自创建，文件的修改时间不同；除了 `modifiedAt` 以外逐比特一致。
    assert_eq!(
        without_modified_at(&stdout_of(&off.run(&["list", "--json"]))),
        without_modified_at(&stdout_of(&bare.run(&["list", "--json"]))),
        "政策关闭时 --json 与没有 worktree 时逐比特一致"
    );
    assert_eq!(
        stdout_of(&off.run(&["list"])),
        stdout_of(&bare.run(&["list"])),
        "人眼输出同样逐比特一致"
    );
    // 有色路径另算一条输出契约，同样不得被 overlay 波及。
    assert_eq!(
        stdout_of(&off.run_colored(&["list"])),
        stdout_of(&bare.run_colored(&["list"])),
        "有色人眼输出逐比特一致"
    );
}

#[test]
fn running_inside_a_linked_worktree_does_not_overlay() {
    // Spec scenario linked worktree 内运行不套用映射.
    let f = Fixture::new("inside", true);
    let wt = f.add_worktree("add-dark-mode");
    check_one_task(&wt);

    let out = f.run_in(&wt, &["list", "--json"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let item = first_change(&out);
    assert!(item.get("worktree").is_none(), "worktree 内不自我 overlay: {item}");
}

#[test]
fn a_branch_outside_the_convention_is_skipped() {
    // Spec scenario 分支不合惯例即略过.
    let f = Fixture::new("branch", true);
    let wt = f.add_worktree_on_branch("add-dark-mode", "feature/add-dark-mode");
    check_one_task(&wt);

    let item = first_change(&f.run(&["list", "--json"]));
    assert!(item.get("worktree").is_none(), "got: {item}");
    assert_eq!(item["completedTasks"], 0, "值仍来自主副本: {item}");
}

#[test]
fn a_worktree_whose_change_is_unknown_is_skipped() {
    // Spec scenario 同名 change 不存在即略过（stderr 无警告）.
    let f = Fixture::new("ghost", true);
    f.add_worktree("ghost-change");

    let out = f.run(&["list", "--json"]);
    assert!(out.status.success());
    let item = first_change(&out);
    assert!(item.get("worktree").is_none(), "got: {item}");
    assert!(
        String::from_utf8_lossy(&out.stderr).trim().is_empty(),
        "stderr 无警告: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn a_worktree_without_the_change_directory_reads_back_the_main_copy() {
    // Spec scenario worktree 内 spec 目录不可读即回读主副本——THEN 同时要求任务
    // 计数与状态来自主副本，那是 CLI 层才观察得到的事实。
    let f = Fixture::new("no-change-dir", true);
    let wt = f.add_worktree("add-dark-mode");
    check_one_task(&wt);
    std::fs::remove_dir_all(wt.join("specseal").join("changes").join("add-dark-mode")).unwrap();

    let out = f.run(&["list", "--json"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let item = first_change(&out);
    assert!(item.get("worktree").is_none(), "映射不成立: {item}");
    assert_eq!(item["completedTasks"], 0, "计数回读主副本: {item}");
    assert_eq!(item["totalTasks"], 2, "计数回读主副本: {item}");
    assert!(!stdout_of(&f.run(&["list"])).contains("[worktree]"), "人眼无标示");
}

#[test]
fn git_failing_outright_leaves_list_working() {
    // Spec scenario git 失败时 fail-open：PATH 清空后 git 不可运行，discovery
    // 回空表，list 照常以 exit 0 输出。
    let f = Fixture::new("no-git", true);
    f.add_worktree("add-dark-mode");

    let out = f.run_in_env(&f.repo.clone(), &["list", "--json"], &[("NO_COLOR", "1"), ("PATH", "")]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let item = first_change(&out);
    assert!(item.get("worktree").is_none(), "git 不可用时无字段: {item}");
}

#[test]
fn an_unparseable_policy_document_disables_the_overlay_without_failing_list() {
    // Spec scenario 坏政策文档不使 list 失败：观察面的政策读取 fail-open，不得把
    // 原本会成功的 list 变成失败。
    let f = Fixture::new("bad-policy", true);
    f.add_worktree("add-dark-mode");
    std::fs::write(f.repo.join("specseal").join("config.yaml"), ": not yaml : [\n").unwrap();

    let out = f.run(&["list", "--json"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let item = first_change(&out);
    assert!(item.get("worktree").is_none(), "坏政策视同关闭: {item}");
}

#[test]
fn a_corrupt_worktree_meta_surfaces_the_existing_diagnostic() {
    // Spec scenario worktree 副本中介数据损坏如实诊断.
    let f = Fixture::new("corrupt", true);
    let wt = f.add_worktree("add-dark-mode");
    std::fs::write(
        wt.join("specseal")
            .join("changes")
            .join("add-dark-mode")
            .join(".meta.yaml"),
        ": not yaml : [\n",
    )
    .unwrap();

    let item = first_change(&f.run(&["list", "--json"]));
    assert!(item.get("metaError").is_some(), "got: {item}");
    assert!(item.get("worktree").is_some(), "映射仍成立: {item}");
}

#[test]
fn change_depends_writes_the_worktree_copy_of_a_mapped_change() {
    // change-plan spec「change depends 动词写入声明依赖」：主 checkout 且政策打开时，
    // 目标 change 已映射到 worktree 就写那份副本——plan 读的也是它，声明立刻可见；
    // 主副本的 meta 不动。前置 add-auth 在分支前就存在，两份 roster 都有它。
    let f = Fixture::new("depends-worktree", true);
    let auth = f.repo.join("specseal").join("changes").join("add-auth");
    std::fs::create_dir_all(&auth).unwrap();
    std::fs::write(auth.join(".meta.yaml"), META).unwrap();
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "add-auth"]);
    let wt = f.add_worktree("add-dark-mode");

    let out = f.run(&["change", "depends", "add-dark-mode", "--on", "add-auth"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let meta_of = |root: &Path| {
        std::fs::read_to_string(
            root.join("specseal")
                .join("changes")
                .join("add-dark-mode")
                .join(".meta.yaml"),
        )
        .unwrap()
    };
    assert_eq!(meta_of(&wt), format!("{META}depends_on: add-auth\n"));
    assert_eq!(meta_of(&f.repo), META, "the main copy stays untouched");
    let plan = json_of(&f.run(&["plan", "--json"]));
    let dark = plan["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "add-dark-mode")
        .cloned()
        .unwrap();
    assert_eq!(dark["dependsOn"], serde_json::json!(["add-auth"]), "{plan}");
    assert_eq!(dark["blockedBy"], serde_json::json!(["add-auth"]), "{plan}");

    // 对照：政策关闭时没有映射，写的是主副本（既有行为）。
    let off = Fixture::new("depends-worktree-off", false);
    let wt = off.add_worktree("add-dark-mode");
    let out = off.run(&["change", "depends", "add-dark-mode", "--on", "add-dark-mode", "--remove"]);
    assert!(!out.status.success(), "self reference still refuses");
    let auth = off.repo.join("specseal").join("changes").join("add-auth");
    std::fs::create_dir_all(&auth).unwrap();
    std::fs::write(auth.join(".meta.yaml"), META).unwrap();
    let out = off.run(&["change", "depends", "add-dark-mode", "--on", "add-auth"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(meta_of(&off.repo), format!("{META}depends_on: add-auth\n"));
    assert_eq!(meta_of(&wt), META, "policy off never touches the worktree copy");
}

#[test]
fn change_field_writes_the_worktree_copy_of_a_mapped_change() {
    // host-free-fields design D4：`change field` 和 `change depends` 一样写进变更所在的那一份。
    // 变更映射到 worktree 时写 worktree 的副本——`list` 读的也是它；主副本的 meta 不动。
    let f = Fixture::new("field-worktree", true);
    let wt = f.add_worktree("add-dark-mode");

    let out = f.run(&["change", "field", "set", "add-dark-mode", "ticket=PROJ-1", "--no-color"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(stdout_of(&out), "✓ add-dark-mode: set ticket\n");
    assert_eq!(meta_at(&wt, "add-dark-mode"), format!("{META}fields:\n  ticket: \"PROJ-1\"\n"));
    assert_eq!(meta_at(&f.repo, "add-dark-mode"), META, "the main copy stays untouched");
    let item = first_change(&f.run(&["list", "--json"]));
    assert_eq!(item["fields"], serde_json::json!({ "ticket": "PROJ-1" }), "{item}");

    let out = f.run(&["change", "field", "unset", "add-dark-mode", "ticket", "--no-color"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(meta_at(&wt, "add-dark-mode"), META);

    // 对照：政策关闭时没有映射，写的是主副本。
    let off = Fixture::new("field-worktree-off", false);
    let wt = off.add_worktree("add-dark-mode");
    let out = off.run(&["change", "field", "set", "add-dark-mode", "ticket=PROJ-1"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(meta_at(&off.repo, "add-dark-mode"), format!("{META}fields:\n  ticket: \"PROJ-1\"\n"));
    assert_eq!(meta_at(&wt, "add-dark-mode"), META, "policy off never touches the worktree copy");
}

#[test]
fn change_schema_writes_the_worktree_copy_of_a_mapped_change() {
    // workflow-schemas Scenario「目标变更在 worktree 内时写入副本」：与 change depends
    // 同一条路由——守门与写入都对 worktree 副本，主副本不动。
    let f = Fixture::new("schema-worktree", true);
    let wt = f.add_worktree("add-dark-mode");
    let out = f.run(&["change", "schema", "add-dark-mode", "no-spec-change"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let meta_of = |root: &Path| {
        std::fs::read_to_string(
            root.join("specseal").join("changes").join("add-dark-mode").join(".meta.yaml"),
        )
        .unwrap()
    };
    assert_eq!(meta_of(&wt), "schema: no-spec-change\ncreated: 2026-07-01\n");
    assert_eq!(meta_of(&f.repo), META, "the main copy stays untouched");

    // 项目层 schema 也从写入的那份副本解析：只在 worktree 里 fork 出来的 schema
    // 切得过去，不会被主 checkout 的 specseal/schemas 误拒。
    let fork = f.run_in(&wt, &["schema", "fork", "spec-driven", "tidy-flow"]);
    assert!(fork.status.success(), "stderr: {}", String::from_utf8_lossy(&fork.stderr));
    let out = f.run(&["change", "schema", "add-dark-mode", "tidy-flow"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(meta_of(&wt), "schema: tidy-flow\ncreated: 2026-07-01\n");
    assert_eq!(meta_of(&f.repo), META, "the main copy stays untouched");
}

#[test]
fn change_rank_writes_the_worktree_copy_of_a_mapped_change() {
    // change-plan spec「change rank 动词写入看板顺序键」：与 change depends 同一
    // 聚合面——主 checkout 且政策打开时，已映射的 change 写它的 worktree 副本，
    // plan 读的也是那份，顺序立刻可见；主副本不动。锚点 add-auth 已有 rank，
    // 这一栏不需补章，只写被移动的那一档。
    let f = Fixture::new("rank-worktree", true);
    let auth = f.repo.join("specseal").join("changes").join("add-auth");
    std::fs::create_dir_all(&auth).unwrap();
    std::fs::write(auth.join(".meta.yaml"), format!("{META}board_rank: n\n")).unwrap();
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "add-auth"]);
    let wt = f.add_worktree("add-dark-mode");

    let out = f.run(&["change", "rank", "add-dark-mode", "--before", "add-auth"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let meta_of = |root: &Path, change: &str| {
        std::fs::read_to_string(root.join("specseal").join("changes").join(change).join(".meta.yaml"))
            .unwrap()
    };
    assert!(meta_of(&wt, "add-dark-mode").contains("board_rank: "), "the worktree copy is ranked");
    assert_eq!(meta_of(&f.repo, "add-dark-mode"), META, "the main copy stays untouched");
    assert_eq!(meta_of(&f.repo, "add-auth"), format!("{META}board_rank: n\n"));
    let plan = json_of(&f.run(&["plan", "--json"]));
    let names: Vec<&str> = plan["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["add-dark-mode", "add-auth"], "{plan}");
}

/// 一个只在主 checkout 新建的 change（worktree 分支之后才出现，副本里没有它）。
fn add_main_only(f: &Fixture, change: &str) {
    let dir = f.repo.join("specseal").join("changes").join(change);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".meta.yaml"), META).unwrap();
}

fn meta_at(root: &Path, change: &str) -> String {
    std::fs::read_to_string(root.join("specseal").join("changes").join(change).join(".meta.yaml"))
        .unwrap()
}

fn plan_order(f: &Fixture) -> Vec<String> {
    json_of(&f.run(&["plan", "--json"]))["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn change_rank_sees_a_change_created_after_the_worktree_branched() {
    // 栏序与 plan 同一视角（主 roster ＋映射 change 的副本）：add-late 只在主
    // checkout，映射到 worktree 的 add-dark-mode 仍可排到它前面。add-late 的补章
    // 写主 checkout，add-dark-mode 的新 rank 写它自己的 worktree 副本。
    let f = Fixture::new("rank-late-anchor", true);
    let wt = f.add_worktree("add-dark-mode");
    add_main_only(&f, "add-late");

    let out = f.run(&["change", "rank", "add-dark-mode", "--before", "add-late"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(meta_at(&f.repo, "add-late").contains("board_rank: "), "add-late stamped in main");
    assert!(meta_at(&wt, "add-dark-mode").contains("board_rank: "), "the worktree copy is ranked");
    assert_eq!(meta_at(&f.repo, "add-dark-mode"), META, "the main copy of a mapped change is untouched");
    assert_eq!(plan_order(&f), ["add-dark-mode", "add-late"]);
}

#[test]
fn change_rank_stamps_each_change_in_its_own_copy() {
    // 补章逐 change 写回各自的副本：add-dark-mode 映射到 worktree、缺 rank，要被
    // 补章；它的章必须落在 worktree 副本（plan 读那份），不能落在主副本。
    let f = Fixture::new("rank-stamp-homes", true);
    let wt = f.add_worktree("add-dark-mode");
    add_main_only(&f, "add-late");

    let out = f.run(&["change", "rank", "add-late", "--after", "add-dark-mode"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(meta_at(&wt, "add-dark-mode").contains("board_rank: "), "the stamp lands in the worktree copy");
    assert_eq!(meta_at(&f.repo, "add-dark-mode"), META, "the main copy is never stamped");
    assert!(meta_at(&f.repo, "add-late").contains("board_rank: "));
    assert_eq!(plan_order(&f), ["add-dark-mode", "add-late"]);
}

#[test]
fn plan_reads_the_worktree_copy_for_the_stage_derivation() {
    // change-plan spec「plan 动词输出波次与阻挡清单」：主 checkout 且政策打开时，
    // plan 与 list 同一聚合面——worktree 内勾掉的任务让阶段判定为 in-progress，
    // 主副本本身仍是 0/2 未开工。
    let f = Fixture::new("plan-stage", true);
    let wt = f.add_worktree("add-dark-mode");
    check_one_task(&wt);

    let out = f.run(&["plan", "--json"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let change = json_of(&out)["changes"][0].clone();
    assert_eq!(change["name"], "add-dark-mode");
    assert_eq!(change["stage"], "in-progress", "stage comes from the worktree copy: {change}");

    // 对照：政策关闭时只读主副本，同一颗 worktree 的勾选不高端段判定。
    let off = Fixture::new("plan-stage-off", false);
    let wt = off.add_worktree("add-dark-mode");
    check_one_task(&wt);
    let change = json_of(&off.run(&["plan", "--json"]))["changes"][0].clone();
    assert_eq!(change["stage"], "proposed", "policy off reads the main copy: {change}");
}
