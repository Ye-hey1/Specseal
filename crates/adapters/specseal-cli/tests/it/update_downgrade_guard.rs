//! `specseal update` 的降级守门（spec「update 动词的降级守门」）。
//!
//! 工作区指令档的标记版号领先引擎时，update 会把它们改写回旧内容——2026-08-05
//! 的实际事故。守门在任何写入之前探测方向，领先即拒绝；`--allow-downgrade`
//! 是唯一的越过方式（不共用 `--force`，避免惯性带旗标把守门静默穿透）。
//!
//! Credential isolation: 每次运行都把 USERPROFILE/HOME/XDG_CONFIG_HOME 指到
//! 抛弃式 "home"，测试绝不碰到真实用户的凭证档。

use specseal_core::init::ASSET_VERSION;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct TempEnv {
    dir: PathBuf,
    home: PathBuf,
}

impl TempEnv {
    /// 以 `init --tools claude` 生成一份现版工作区。
    fn new(tag: &str) -> TempEnv {
        let base = std::env::temp_dir().join(format!(
            "specseal-cli-downgrade-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("project");
        let home = base.join("home");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let env = TempEnv { dir, home };
        let out = env.run(&["init", "--tools", "claude"]);
        assert!(out.status.success(), "init stderr: {}", stderr_of(&out));
        env
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(args)
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_LOCALE")
            .env_remove("SPECSEAL_SPEC_LOCALE")
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .env_remove("CLICOLOR_FORCE")
            .env("USERPROFILE", &self.home)
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", &self.home)
            .output()
            .expect("run specseal binary")
    }

    /// 把工作区每份技能档的 frontmatter 版号改成指定值（仿真由别版引擎生成的工作区）。
    fn set_skill_version(&self, version: &str) {
        specseal_core::testkit::set_skill_version(&self.dir.join(".claude").join("skills"), version);
    }

    fn skill_path(&self) -> PathBuf {
        self.dir
            .join(".claude")
            .join("skills")
            .join("specseal-propose")
            .join("SKILL.md")
    }

    fn skill_version(&self) -> String {
        specseal_core::testkit::skill_frontmatter_version(&self.skill_path())
    }

    /// 目录的完整内容快照（相对路径与文件字节），供「零写入」断言比对。
    fn snapshot(&self) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().to_string();
                let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                if entry.path().is_dir() {
                    out.push((format!("{rel}/"), Vec::new()));
                    walk(&entry.path(), &rel, out);
                } else {
                    out.push((rel, std::fs::read(entry.path()).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.dir, "", &mut out);
        out
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

/// 比现版领先一个主版号的版号。
fn ahead_of_current() -> String {
    let major: u64 = ASSET_VERSION
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .expect("ASSET_VERSION 主版号可解析");
    format!("v{}.0.0", major + 1)
}

/// Scenario「较新工作区拒绝 update」。
#[test]
fn a_newer_workspace_is_refused_with_zero_writes() {
    let env = TempEnv::new("refused");
    let ahead = ahead_of_current();
    env.set_skill_version(&ahead);
    let before = env.snapshot();

    let out = env.run(&["update"]);

    assert!(!out.status.success(), "must exit non-zero");
    let stderr = stderr_of(&out);
    assert_eq!(
        stderr.trim_end().lines().count(),
        1,
        "stderr must be a single line: {stderr}"
    );
    assert!(stderr.contains(&ahead), "stderr must name the workspace version: {stderr}");
    assert!(
        stderr.contains(ASSET_VERSION),
        "stderr must name the engine version: {stderr}"
    );
    assert_eq!(env.snapshot(), before, "no file may be created or modified");
}

/// Scenario「--allow-downgrade 越过守门」。
#[test]
fn allow_downgrade_regenerates_at_the_engine_version() {
    let env = TempEnv::new("allowed");
    env.set_skill_version(&ahead_of_current());

    let out = env.run(&["update", "--allow-downgrade"]);

    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(env.skill_version(), ASSET_VERSION, "受管档须再生为引擎现版");
}

/// 守门对所有再生路径一体适用：workflow-config 写入后的技能同步同样经过引擎
/// 的 update，领先的工作区在该步被拒——config 已写入（既有的同步失败形状），
/// 但受管档零改写。
#[test]
fn workflow_config_worktree_sync_refuses_a_newer_workspace() {
    let env = TempEnv::new("wfconfig");
    let ahead = ahead_of_current();
    env.set_skill_version(&ahead);
    let before = std::fs::read_to_string(env.skill_path()).unwrap();

    let out = env.run(&["workflow-config", "set", "worktree", "true"]);

    assert!(!out.status.success(), "sync 必须被拒，exit 非零");
    let stderr = stderr_of(&out);
    assert!(
        stderr.contains(&ahead) && stderr.contains(ASSET_VERSION),
        "stderr 须含两版号：{stderr}"
    );
    assert_eq!(
        std::fs::read_to_string(env.skill_path()).unwrap(),
        before,
        "领先的受管档不得被改写"
    );
    // 钉住既有的同步失败形状：config 本体已写入（半状态是此路径的文档化行为），
    // 只有技能足迹同步被守门挡下。
    let config = std::fs::read_to_string(env.dir.join("specseal/config.yaml")).unwrap();
    assert!(config.contains("worktree: true"), "config 须已写入 worktree: true：{config}");
}

/// Scenario「过期工作区照常更新」：守门引入前后行为相同。
#[test]
fn a_stale_workspace_still_updates_without_the_flag() {
    let env = TempEnv::new("stale");
    env.set_skill_version("v0.9.0");

    let out = env.run(&["update"]);

    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(env.skill_version(), ASSET_VERSION, "受管档须再生为引擎现版");
}
