//! `specseal/manual/`（手册页目录）对 `specseal list --json`、`specseal list --specs
//! --json` 与 `specseal validate --specs` 无感（spec manual-pages「手册页的落点与
//! 文件名」；design「手册落点 specseal/manual/ 且 list 与 validate 无感」）。
//!
//! 手册是规格的衍生物，与源头同住 `specseal/`；引擎动词不得因多出这个目录而改变
//! 输出。以 `specseal init` 建工作区、放一个 change 与一份正式规格后，先记录各指令
//! 的 stdout 与 exit code，再放入一页合规 frontmatter 六栏的 `index.md` 重跑，
//! stdout 逐比特比对、exit code 皆为 0。`list --json` 只列 changes、`list --specs
//! --json` 只列正式规格的能力，两条路径各守各的。
//!
//! Credential isolation: 每次运行都把 USERPROFILE/HOME/XDG_CONFIG_HOME 指到
//! 抛弃式 "home"，测试绝不碰到真实用户的凭证档。

use std::path::PathBuf;
use std::process::{Command, Output};

const META: &str = "schema: spec-driven\ncreated: 2026-09-01\n";
const GOOD_PURPOSE: &str =
    "本 capability 负责搜索结果的排序与分页，涵盖查找改写、排序权重与空结果的可观察行为。";
/// manual-pages 契约的 frontmatter 六栏（首页的 `sources` 得为空数组）＋出处行。
const INDEX_PAGE: &str = "---\n\
title: 操作手册\n\
section: 开始使用\n\
order: 10\n\
keywords: [手册, 入门]\n\
sources: []\n\
generated: 2026-09-02\n\
---\n\
\n\
# 操作手册\n\
\n\
一句话定位系统。\n\
\n\
**出处**：\n";

struct TempEnv {
    dir: PathBuf,
    home: PathBuf,
}

impl TempEnv {
    /// `specseal init --tools claude` 后补一个 change `demo` 与一份正式规格 `search`，
    /// 让 list 与 validate 的输出都非空。
    fn new(tag: &str) -> TempEnv {
        let base = std::env::temp_dir().join(format!(
            "specseal-cli-manual-dir-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("project");
        let home = base.join("home");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let env = TempEnv { dir, home };

        let init = env.run(&["init", "--tools", "claude"]);
        assert!(init.status.success(), "init stderr: {}", stderr_of(&init));

        let change = env.dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), "- [ ] 1.1 a\n").unwrap();

        let spec = env.dir.join("specseal").join("specs").join("search");
        std::fs::create_dir_all(&spec).unwrap();
        std::fs::write(
            spec.join("spec.md"),
            format!("# search Specification\n\n## Purpose\n\n{GOOD_PURPOSE}\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n"),
        )
        .unwrap();
        env
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(args)
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_LOCALE")
            .env_remove("SPECSEAL_SPEC_LOCALE")
            .env_remove("SPECSEAL_TDD")
            .env_remove("SPECSEAL_AUDIT")
            .env_remove("SPECSEAL_WORKTREE")
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .env_remove("CLICOLOR_FORCE")
            .env("USERPROFILE", &self.home)
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", &self.home)
            .output()
            .expect("run specseal binary")
    }

    /// 放入一页合规的手册首页（目录不存在时创建），回传其路径。
    fn write_manual_index(&self) -> PathBuf {
        let manual = self.dir.join("specseal").join("manual");
        std::fs::create_dir_all(&manual).unwrap();
        let index = manual.join("index.md");
        std::fs::write(&index, INDEX_PAGE).unwrap();
        index
    }
}

impl Drop for TempEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.dir.parent().unwrap());
    }
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

/// 两次运行的 stdout 逐比特一致且 exit code 皆为 0。
fn assert_same_success(before: &Output, after: &Output, verb: &str) {
    assert!(before.status.success(), "{verb} 无手册目录时零收尾: {}", stderr_of(before));
    assert!(after.status.success(), "{verb} 有手册目录时零收尾: {}", stderr_of(after));
    assert_eq!(
        String::from_utf8_lossy(&after.stdout),
        String::from_utf8_lossy(&before.stdout),
        "{verb} 的 stdout 不得因 specseal/manual/ 出现而改变"
    );
}

#[test]
fn list_json_is_unchanged_by_the_manual_dir() {
    let env = TempEnv::new("list");
    let before = env.run(&["list", "--json"]);
    assert!(
        String::from_utf8_lossy(&before.stdout).contains("demo"),
        "对照组必须非空，否则比对无意义"
    );

    let index = env.write_manual_index();
    assert!(index.is_file(), "手册首页落在 specseal/manual/index.md");

    let after = env.run(&["list", "--json"]);
    assert_same_success(&before, &after, "list --json");
}

#[test]
fn list_specs_json_is_unchanged_by_the_manual_dir() {
    let env = TempEnv::new("list-specs");
    let before = env.run(&["list", "--specs", "--json"]);
    assert!(
        String::from_utf8_lossy(&before.stdout).contains("search"),
        "对照组必须列出正式规格，否则比对无意义"
    );

    env.write_manual_index();

    let after = env.run(&["list", "--specs", "--json"]);
    assert_same_success(&before, &after, "list --specs --json");
}

#[test]
fn validate_specs_is_unchanged_by_the_manual_dir() {
    let env = TempEnv::new("validate");
    let before = env.run(&["validate", "--specs", "--no-color"]);
    assert!(
        String::from_utf8_lossy(&before.stdout).contains("search"),
        "对照组必须点名正式规格，否则比对无意义"
    );

    env.write_manual_index();

    let after = env.run(&["validate", "--specs", "--no-color"]);
    assert_same_success(&before, &after, "validate --specs");
}
