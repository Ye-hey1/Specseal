//! `specseal init` 的内置工具选集契约（spec「init 内置 Agent 工具选择」、
//! 「remote 初始化与连接指令」与 design 的「CLI observable behavior」）。
//!
//! filesystem 与 Remote Store 两条 init 共用同一个工具解析入口：显式 `--tools`
//! 直接采用，缺旗标且 stdin 非交互终端时在任何写入之前以非零 exit code 失败。
//! `Command::output()` 的 stdin 是 /dev/null（非终端），因此本档覆盖的正是非交互
//! 路径；交互 prompt 的单选／双选／全否重试由 `verbs/init.rs` 的单元测试覆盖。
//!
//! Credential isolation: 每次运行都把 USERPROFILE/HOME/XDG_CONFIG_HOME 指到
//! 抛弃式 "home"，测试绝不碰到真实用户的凭证档。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct TempEnv {
    dir: PathBuf,
    home: PathBuf,
}

impl TempEnv {
    fn new(tag: &str) -> TempEnv {
        let base = std::env::temp_dir().join(format!(
            "specseal-cli-inittools-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("project");
        let home = base.join("home");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        TempEnv { dir, home }
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

    fn app_yaml(&self) -> serde_yaml::Value {
        let text = std::fs::read_to_string(self.dir.join(".specseal.yaml"))
            .expect(".specseal.yaml exists");
        serde_yaml::from_str(&text).expect(".specseal.yaml parses")
    }

    fn builtins(&self) -> Vec<String> {
        self.app_yaml()
            .get("tools")
            .and_then(|t| t.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn exists(&self, rel: &str) -> bool {
        self.dir.join(rel.split('/').collect::<PathBuf>()).exists()
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

const URL: &str = "https://team.example.com/specseal/projects/foo";

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

/// 缺旗标与非法选集共用的错误形状：单行 stderr、stdout 全空、exit code 非零。
fn assert_rejected_with_zero_writes(env: &TempEnv, out: &Output, before: &[(String, Vec<u8>)]) {
    assert!(!out.status.success(), "must exit non-zero");
    assert_eq!(stdout_of(out), "", "stdout must stay empty");
    assert_eq!(
        stderr_of(out).trim_end().lines().count(),
        1,
        "stderr must be a single line: {}",
        stderr_of(out)
    );
    assert_eq!(env.snapshot(), before, "no file may be created or modified");
}

// --- 显式 --tools（spec Scenario「filesystem init 显式选择 Codex」） ---

#[test]
fn fs_init_explicit_tools_generate_exactly_the_selection() {
    // 每种显式选法逐一：只有被选取的工具留下 Skills（没选的工具连目录都不留）；指令档一律
    // 不生成；Generated files 行依记录顺串行出选集。
    let cases: [(&str, &[&str]); 11] = [
        ("claude", &["claude"]),
        ("codex", &["codex"]),
        ("claude,codex", &["claude", "codex"]),
        ("copilot", &["copilot"]),
        ("claude,codex,copilot", &["claude", "codex", "copilot"]),
        ("pi", &["pi"]),
        ("Pi", &["pi"]),
        ("cursor", &["cursor"]),
        ("CURSOR", &["cursor"]),
        ("cursor,cursor", &["cursor"]),
        (
            "claude,codex,copilot,pi,cursor",
            &["claude", "codex", "copilot", "pi", "cursor"],
        ),
    ];
    for (spec, want) in cases {
        let env = TempEnv::new(&format!("fs-explicit-{}", spec.replace(',', "-")));
        let out = env.run(&["init", "--tools", spec]);
        assert!(out.status.success(), "--tools {spec} stderr: {}", stderr_of(&out));

        let stdout = stdout_of(&out);
        assert!(stdout.contains("Initialized at"), "--tools {spec} stdout: {stdout}");
        assert!(stdout.contains("Generated files for:"), "--tools {spec} stdout: {stdout}");
        assert_eq!(env.builtins(), want, "--tools {spec}: recorded selection");

        // spec Scenario「指令档零受管区块」：受管集合只剩技能档；Copilot 也不写指令档。
        for file in ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"] {
            assert!(!env.exists(file), "--tools {spec}: {file} 不得生成");
        }
        let generated = stdout
            .lines()
            .find(|l| l.starts_with("Generated files for:"))
            .unwrap();
        assert_eq!(
            generated,
            format!("Generated files for: {}", want.join(", ")),
            "--tools {spec}"
        );
        // spec Scenario「filesystem init 显式选择 Copilot／Pi／Cursor」：每个工具的技能在自己
        // 的 skills 目录，没选的工具连目录都不留。
        for (tool, top, skill) in [
            ("claude", ".claude", ".claude/skills/specseal-propose/SKILL.md"),
            ("codex", ".agents", ".agents/skills/specseal-propose/SKILL.md"),
            ("copilot", ".github", ".github/skills/specseal-propose/SKILL.md"),
            ("pi", ".pi", ".pi/skills/specseal-propose/SKILL.md"),
            ("cursor", ".cursor", ".cursor/skills/specseal-propose/SKILL.md"),
        ] {
            let selected = want.contains(&tool);
            assert_eq!(env.exists(skill), selected, "--tools {spec}: {skill}");
            assert_eq!(env.exists(top), selected, "--tools {spec}: {top}/");
            if selected {
                let entries: Vec<String> = std::fs::read_dir(env.dir.join(top))
                    .unwrap()
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect();
                assert_eq!(entries, ["skills"], "--tools {spec}: {top}/ 下只能有 skills/");
            }
        }
        assert!(env.exists("specseal/specs"), "--tools {spec}: filesystem spec tree");
    }
}

/// spec Scenario「Remote init 显式选择两个工具」。
#[test]
fn remote_init_explicit_both_tools_writes_section_without_a_spec_tree() {
    let env = TempEnv::new("remote-explicit-both");
    let out = env.run(&[
        "init", "--store", "remote", "--url", URL, "--repo", "backend", "--tools", "claude,codex",
    ]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));

    assert_eq!(env.builtins(), vec!["claude", "codex"]);
    let yaml = env.app_yaml();
    let remote = yaml.get("remote").expect("remote section present");
    assert_eq!(remote.get("url").and_then(|v| v.as_str()), Some(URL));
    assert_eq!(remote.get("repo").and_then(|v| v.as_str()), Some("backend"));
    assert!(env.exists(".claude/skills/specseal-propose/SKILL.md"));
    assert!(env.exists(".agents/skills/specseal-propose/SKILL.md"));
    assert!(!env.exists("specseal"), "remote 模式不创建本机规格树");
}

// --- 范本的政策示例（spec Scenario「新项目初始化的范本内容」） ---

/// 与 specseal_core::config::PolicyKey::ALL 刻意重复（design D6：钉桩测试自带清单才钉得住）。
/// 增删政策键时两处同步。
const POLICY_KEYS: [&str; 5] = ["locale", "spec_locale", "tdd", "audit", "worktree"];

const POLICY_ENV: [&str; 5] = [
    "SPECSEAL_LOCALE",
    "SPECSEAL_SPEC_LOCALE",
    "SPECSEAL_TDD",
    "SPECSEAL_AUDIT",
    "SPECSEAL_WORKTREE",
];

/// 范本是否把 `key` 示范成一个键（`# key: …`）。以行为单位比对，`locale` 才不会
/// 被 `spec_locale` 这种较长的键名蒙混过关；缩进、注解符号与说明措辞都不参与。
fn documents_key(text: &str, key: &str) -> bool {
    text.lines().any(|line| {
        line.trim_start()
            .trim_start_matches('#')
            .trim_start()
            .starts_with(&format!("{key}:"))
    })
}

#[test]
fn init_workflow_config_template_documents_every_policy_key() {
    let env = TempEnv::new("template-policy");
    let out = env.run(&["init", "--tools", "claude"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));

    let workflow = std::fs::read_to_string(env.dir.join("specseal").join("config.yaml"))
        .expect("specseal/config.yaml exists");
    for key in POLICY_KEYS {
        assert!(documents_key(&workflow, key), "范本示范政策键 {key}:\n{workflow}");
    }
    for name in POLICY_ENV {
        assert!(workflow.contains(name), "范本的覆写提示列出 {name}:\n{workflow}");
    }

    // 政策的正典归属只有 specseal/config.yaml 一处：.specseal.yaml 不得把任何
    // 政策键写成键（含注解示例）。与上方同一把行首比对，措辞撞字不误红。
    let app = std::fs::read_to_string(env.dir.join(".specseal.yaml")).expect(".specseal.yaml exists");
    for key in POLICY_KEYS {
        assert!(!documents_key(&app, key), ".specseal.yaml 不得带政策键 {key}:\n{app}");
    }
}

// --- 非交互缺少 --tools（spec Scenario「非交互 init 缺少 tools 零写入失败」） ---

/// 缺选集的单行消息：`pi` 是 `copilot` 的子字符串，逐 token 比对测不到漏列，故比全文。
const FIVE_TOOLS_HINT: &str = "no AI tool selected — pass --tools with one or more of claude, codex, copilot, pi, cursor (comma-separated, e.g. --tools claude,cursor)";

#[test]
fn fs_init_without_tools_on_a_pipe_fails_with_zero_writes() {
    let env = TempEnv::new("fs-missing-tools");
    let before = env.snapshot();

    let out = env.run(&["init"]);

    assert_rejected_with_zero_writes(&env, &out, &before);
    assert_eq!(stderr_of(&out).trim_end(), format!("Error: {FIVE_TOOLS_HINT}"));
}

/// spec Scenario「Remote init 非交互缺少 tools 被拒」。
#[test]
fn remote_init_without_tools_on_a_pipe_fails_with_zero_writes() {
    let env = TempEnv::new("remote-missing-tools");
    let before = env.snapshot();

    let out = env.run(&["init", "--store", "remote", "--url", URL, "--repo", "backend"]);

    assert_rejected_with_zero_writes(&env, &out, &before);
    assert_eq!(stderr_of(&out).trim_end(), format!("Error: {FIVE_TOOLS_HINT}"));
}

// --- 空／未知的显式值（spec Scenario「空或未知的显式 tools 被拒」） ---

#[test]
fn explicit_empty_tools_value_is_rejected_with_zero_writes() {
    let env = TempEnv::new("empty-tools");
    let before = env.snapshot();

    let out = env.run(&["init", "--tools", ""]);

    assert_rejected_with_zero_writes(&env, &out, &before);
}

#[test]
fn explicit_unknown_tool_is_rejected_with_zero_writes() {
    let env = TempEnv::new("unknown-tool");
    let before = env.snapshot();

    let out = env.run(&["init", "--tools", "claude,vscode"]);

    assert_rejected_with_zero_writes(&env, &out, &before);
    assert!(
        stderr_of(&out).contains("vscode"),
        "stderr must name the offender: {}",
        stderr_of(&out)
    );
}

#[test]
fn explicit_tool_aliases_are_rejected_listing_the_supported_tools() {
    // Example「--tools 值的解析」的拒绝列：不收别名。输入本身就含工具名，要比对完整
    // 的支持清单，单看 token 测不到漏列。
    for unknown in ["github-copilot", "cursor-agent"] {
        let env = TempEnv::new(&format!("unknown-{unknown}"));
        let before = env.snapshot();

        let out = env.run(&["init", "--tools", unknown]);

        assert_rejected_with_zero_writes(&env, &out, &before);
        assert_eq!(
            stderr_of(&out).trim_end(),
            format!("Error: unknown tool: {unknown} (supported: claude, codex, copilot, pi, cursor)")
        );
    }
}

// --- --no-color（spec Scenario「no-color 不改变工具选择语意」） ---

#[test]
fn no_color_init_emits_no_ansi_and_the_same_file_effects() {
    let colored = TempEnv::new("nocolor-baseline");
    let plain = TempEnv::new("nocolor-plain");

    let a = colored.run(&["init", "--tools", "claude"]);
    let b = plain.run(&["--no-color", "init", "--tools", "claude"]);

    assert!(a.status.success() && b.status.success());
    assert_eq!(a.status.code(), b.status.code(), "exit code identical");
    assert!(
        !stdout_of(&b).contains('\x1b') && !stderr_of(&b).contains('\x1b'),
        "--no-color output must carry no ANSI escape: {:?}",
        (stdout_of(&b), stderr_of(&b))
    );
    assert_eq!(plain.builtins(), colored.builtins(), "文件效果与有色模式相同");
    assert_eq!(plain.exists("CLAUDE.md"), colored.exists("CLAUDE.md"));
    assert_eq!(
        plain.exists(".claude/skills/specseal-propose/SKILL.md"),
        colored.exists(".claude/skills/specseal-propose/SKILL.md")
    );
}

#[test]
fn force_reinit_with_a_new_selection_prunes_the_old_tool_and_keeps_the_two_line_summary() {
    // spec Scenario「init --force 切换工具时清除下架足迹」的 CLI 面：exit code 0、
    // stdout 仍是既有两行，未选工具的技能目录整组消失、选中工具补齐。
    let env = TempEnv::new("fs-force-switch");
    let first = env.run(&["init", "--tools", "claude"]);
    assert!(first.status.success(), "stderr: {}", stderr_of(&first));
    assert!(env.exists(".claude/skills/specseal-propose/SKILL.md"), "前置：Claude 技能已生成");

    let out = env.run(&["init", "--force", "--tools", "codex"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let stdout = stdout_of(&out);
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 2, "init 的摘要维持两行，不添加清理明细：{stdout}");
    assert!(lines[0].contains("Initialized at"), "{stdout}");
    assert_eq!(lines[1], "Generated files for: codex", "{stdout}");
    assert_eq!(env.builtins(), ["codex"], "recorded selection");
    assert!(!env.exists(".claude/skills/specseal-propose/SKILL.md"), "未选工具的技能档须移除");
    assert!(!env.exists(".claude"), "空掉的 .claude 目录一并移除");
    assert!(env.exists(".agents/skills/specseal-propose/SKILL.md"), "选中工具补齐");
}

/// spec Scenario「削去后等同项目根的 skills_dir 被拒」与「与内置工具 skills 目录相撞被拒」：
/// 描述子的目录在验证边界挡下，update 零写入、既有技能档不动。
#[test]
fn update_rejects_a_descriptor_skills_dir_at_the_root_or_a_builtin_directory() {
    for (tag, bad, needle) in [
        ("root", "/", "project root"),
        ("builtin", ".claude/skills", "built-in"),
        ("copilot", ".github/skills", "built-in copilot"),
        ("pi", ".pi/skills", "built-in pi"),
        ("cursor", ".Cursor/skills", "built-in cursor"),
    ] {
        let env = TempEnv::new(&format!("descriptor-bad-dir-{tag}"));
        assert!(env.run(&["init", "--tools", "claude"]).status.success());
        std::fs::write(
            env.dir.join(".specseal.yaml"),
            format!("tools:\n  - claude\n  - name: wad-harness\n    skills_dir: {bad}\n"),
        )
        .unwrap();
        let before = env.snapshot();

        let out = env.run(&["update"]);

        assert!(!out.status.success(), "{tag}: must exit non-zero");
        let stderr = stderr_of(&out);
        assert!(stderr.contains("skills_dir"), "{tag}: must name the field: {stderr}");
        assert!(stderr.contains(needle), "{tag}: must give the reason: {stderr}");
        assert_eq!(env.snapshot(), before, "{tag}: 拒绝＝零写入");
    }
}
