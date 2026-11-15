//! Test-support helpers shared by this workspace's test suites (doc-hidden, not API).
//!
//! 「把工作区技能档的版号改成指定值」在 core、CLI 与 desktop 的测试各需要一份——
//! 集中在这里，frontmatter 的读写逻辑才不会抄三份、改一处漏两处。

use std::path::{Path, PathBuf};

/// `root` 之外的 worktree 路径，逐字取 `git worktree list --porcelain` 的拼法——产品
/// 也是这样取的。期望值不得自行 canonicalize：Windows 上它会加 `\\?\` 前缀，git
/// 回报的却是正斜线路径，两种拼法指同一目录仍对不上。
pub fn listed_worktrees(root: &Path) -> Vec<PathBuf> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .expect("git worktree list");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .skip(1)
        .map(PathBuf::from)
        .collect()
}

/// 把 `skills_root` 下每份 specseal-*/SKILL.md 的 frontmatter 版号字符串改成
/// `version`（仿真以别版引擎生成的工作区——旧值仿真落后、新值仿真领先）。
pub fn set_skill_version(skills_root: &Path, version: &str) {
    for entry in std::fs::read_dir(skills_root).expect("skills 目录存在").flatten() {
        let file = entry.path().join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&file)
            .unwrap()
            .replace(crate::init::ASSET_VERSION, version);
        std::fs::write(&file, text).unwrap();
    }
}

/// 在 `skills_root` 下写一份 `<name>/SKILL.md`，frontmatter 带 `version`——不经
/// `specseal update` 生成技能时（例如 remote 模式的测试项目）仿真某版引擎的产物。
pub fn write_skill_file(skills_root: &Path, name: &str, version: &str) {
    let dir = skills_root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let text = format!("---\nname: {name}\nmetadata:\n  version: \"{version}\"\n---\n");
    std::fs::write(dir.join("SKILL.md"), text).unwrap();
}

/// 读一份 SKILL.md frontmatter 的版号值（不含引号）；测试断言用。
pub fn skill_frontmatter_version(skill_file: &Path) -> String {
    let text = std::fs::read_to_string(skill_file).expect("SKILL.md exists");
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with("version:"))
        .expect("frontmatter carries a version line");
    line.split_once("version:").unwrap().1.trim().trim_matches('"').to_string()
}
