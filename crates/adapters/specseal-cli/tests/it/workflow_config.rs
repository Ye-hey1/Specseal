//! `specseal workflow-config` — the CLI verb that manages `specseal/config.yaml`
//! (workflow policy, context, rules), in both fs and remote mode.
//!
//! fs mode reads and writes the file through the workspace; remote mode reads
//! the server document with its revision, applies the SAME core rewrite, and
//! writes back guarded by that revision. Both share one rendering path, so the
//! `--json` payload shape is asserted identically for each.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

use specseal_core::init::ASSET_VERSION;
use specseal_core::testkit::{set_skill_version, write_skill_file};

// --- fs fixture ---

/// A workflow config with a value in every surface the verb touches: two policy
/// keys set (locale, tdd), two left unset (spec_locale, audit), a context block,
/// and two rule sections.
const WF_YAML: &str = "\
schema: spec-driven
locale: tw
tdd: true
context: |
  Project context line one.
  Line two.
rules:
  design:
  - Name the crate boundary
  - List one alternative
  tasks:
  - Use checkbox format
";

const BAD_YAML: &str = ": not yaml : [\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn new(tag: &str, wf_yaml: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-workflow-config-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("specseal")).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        std::fs::write(dir.join("specseal").join("config.yaml"), wf_yaml).unwrap();
        TempProject { dir }
    }

    fn config_path(&self) -> PathBuf {
        self.dir.join("specseal").join("config.yaml")
    }

    fn config_bytes(&self) -> Vec<u8> {
        std::fs::read(self.config_path()).expect("read config.yaml")
    }

    fn config_text(&self) -> String {
        std::fs::read_to_string(self.config_path()).expect("read config.yaml")
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(args).current_dir(&self.dir).env("NO_COLOR", "1");
        for key in [
            "SPECSEAL_LOCALE",
            "SPECSEAL_SPEC_LOCALE",
            "SPECSEAL_TDD",
            "SPECSEAL_AUDIT",
            "SPECSEAL_WORKTREE",
            "SPECSEAL_STORE_URL",
        ] {
            cmd.env_remove(key);
        }
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().expect("run specseal binary")
    }

    fn run_env(&self, args: &[&str], envs: &[(&str, &str)]) -> Output {
        let mut cmd = self.cmd(args);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd.output().expect("run specseal binary")
    }

    fn run_stdin(&self, args: &[&str], stdin: &str) -> Output {
        run_with_stdin(self.cmd(args), stdin)
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn run_with_stdin(mut cmd: Command, stdin: &str) -> Output {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn specseal binary");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().expect("wait specseal binary")
}

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

fn json_of(out: &Output) -> serde_json::Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!("stdout is JSON ({e}): {}", stdout_of(out));
    })
}

// --- show (fs) ---

#[test]
fn show_prints_canonical_policy_context_and_rules() {
    // Spec scenario fs 模式显示正典值.
    let p = TempProject::new("show-human", WF_YAML);
    let out = p.run(&["workflow-config", "show"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let text = stdout_of(&out);
    assert!(text.contains("locale"), "policy fields listed: {text}");
    assert!(text.contains("tw"), "locale value shown: {text}");
    let tdd_line = text.lines().find(|l| l.contains("tdd")).unwrap_or_default();
    assert!(tdd_line.contains("on"), "tdd shown as on: {text}");
    let audit_line = text.lines().find(|l| l.contains("audit")).unwrap_or_default();
    assert!(
        audit_line.contains("unset") && audit_line.contains("off"),
        "audit shown as unset with its default: {text}"
    );
    let worktree_line = text.lines().find(|l| l.contains("worktree")).unwrap_or_default();
    assert!(
        worktree_line.contains("unset") && worktree_line.contains("off"),
        "worktree shown as unset with its default: {text}"
    );
    let context_line = text.lines().find(|l| l.contains("context")).unwrap_or_default();
    assert!(context_line.contains('2'), "context line count shown: {text}");
    let rules_line = text.lines().find(|l| l.contains("rules")).unwrap_or_default();
    assert!(
        rules_line.contains("design") && rules_line.contains('2'),
        "rules section counts shown: {text}"
    );
    assert!(!text.contains('\u{1b}'), "no ANSI escapes: {text:?}");
}

#[test]
fn show_json_payload_is_camel_case_with_null_for_unset() {
    // Spec scenario --json payload 形状.
    let p = TempProject::new("show-json", WF_YAML);
    let out = p.run(&["workflow-config", "show", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let payload = json_of(&out);
    assert_eq!(payload["locale"], "tw");
    assert!(payload["specLocale"].is_null(), "unset specLocale is null: {payload}");
    assert_eq!(payload["tdd"], true);
    assert_eq!(payload["audit"], false, "unset tdd/audit read as false");
    assert_eq!(payload["worktree"], false, "unset worktree reads as false");
    assert!(
        payload["context"].as_str().unwrap().contains("Project context line one."),
        "context text carried: {payload}"
    );
    assert_eq!(
        payload["rules"]["design"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["Name the crate boundary", "List one alternative"]
    );
    let keys: Vec<&str> = payload.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert!(!keys.contains(&"spec_locale"), "no snake_case keys: {keys:?}");
}

#[test]
fn show_json_reports_the_canonical_value_not_the_env_override() {
    // Spec scenario show 不应用环境变量覆写.
    let p = TempProject::new("show-env", WF_YAML);
    let out = p.run_env(
        &["workflow-config", "show", "--json"],
        &[("SPECSEAL_TDD", "false")],
    );
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(json_of(&out)["tdd"], true, "canonical value wins over the env layer");
}

#[test]
fn show_fails_closed_on_an_unparseable_config() {
    // Spec scenario 坏 config fail-closed.
    let p = TempProject::new("show-bad", BAD_YAML);
    let out = p.run(&["workflow-config", "show"]);
    assert!(!out.status.success(), "must exit non-zero on a broken config");
    assert!(
        stderr_of(&out).contains("specseal/config.yaml"),
        "stderr names the file: {}",
        stderr_of(&out)
    );
    assert!(stdout_of(&out).trim().is_empty(), "no payload on stdout");
}

// --- set (fs) ---

#[test]
fn set_locale_writes_the_key_and_preserves_the_others() {
    // Spec scenario 设置 locale 保留其他键.
    let p = TempProject::new("set-locale", WF_YAML);
    let out = p.run(&["workflow-config", "set", "locale", "ja"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    // 手术改写：仅 locale 行变动，其余行逐比特保留（不再整档重排）。
    assert_eq!(p.config_text(), WF_YAML.replace("locale: tw", "locale: ja"));
}

#[test]
fn set_leaves_no_temp_residue_beside_the_config() {
    // Spec scenario 设置写入走同一原子入口——观察面：写入成功后 specseal/ 无暂存
    // 残留、config.yaml 为完整全文。
    let p = TempProject::new("set-atomic-face", WF_YAML);
    let out = p.run(&["workflow-config", "set", "locale", "ja"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let residue: Vec<String> = std::fs::read_dir(p.dir.join("specseal"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect();
    assert!(residue.is_empty(), "temp residue left behind: {residue:?}");
    assert_eq!(p.config_text(), WF_YAML.replace("locale: tw", "locale: ja"));
}

#[test]
fn set_rejects_an_unknown_key_without_touching_the_file() {
    // Spec scenario 未知 key 拒绝.
    let p = TempProject::new("set-unknown", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "theme", "dark"]);
    assert!(!out.status.success(), "unknown key must exit non-zero");
    let err = stderr_of(&out);
    for key in ["locale", "spec_locale", "tdd", "audit", "worktree"] {
        assert!(err.contains(key), "stderr lists the accepted keys ({key}): {err}");
    }
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

#[test]
fn set_rejects_a_non_boolean_toggle_value() {
    // Spec scenario 非法布尔值拒绝.
    let p = TempProject::new("set-bad-bool", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "tdd", "yes"]);
    assert!(!out.status.success(), "non-boolean value must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("tdd"), "stderr names the key: {err}");
    assert!(
        err.contains("true") && err.contains("false"),
        "stderr states the accepted values: {err}"
    );
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn set_false_removes_the_key() {
    // Spec scenario 设 false 移除键.
    let p = TempProject::new("set-false", "schema: spec-driven\naudit: true\n");
    let out = p.run(&["workflow-config", "set", "audit", "false"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    // 手术改写：仅 audit 键行被移除，其余行逐比特保留。
    assert_eq!(p.config_text(), "schema: spec-driven\n");
}

#[test]
fn set_worktree_true_lands_in_the_file_and_in_show() {
    // Spec scenario worktree 字段写入与呈现.
    let p = TempProject::new("set-worktree", WF_YAML);
    let out = p.run(&["workflow-config", "set", "worktree", "true"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(
        p.config_text().contains("worktree: true"),
        "config.yaml carries the key: {}",
        p.config_text()
    );
    let payload = json_of(&p.run(&["workflow-config", "show", "--json"]));
    assert_eq!(payload["worktree"], true, "show reflects the write: {payload}");
    let text = stdout_of(&p.run(&["workflow-config", "show"]));
    let line = text.lines().find(|l| l.contains("worktree")).unwrap_or_default();
    assert!(line.contains("on"), "human output shows worktree on: {text}");
}

#[test]
fn set_worktree_on_a_legacy_layout_syncs_skills_without_moving_the_folder() {
    // spec「技能足迹同步不迁移规格文件夹」Scenario「CLI 切换 worktree 不迁移」：不在 git 里，
    // 迁移没有暂缓条件，`specseal update` 会搬——设置写入的同步不得搬。
    let p = TempProject::new("set-worktree-legacy", WF_YAML);
    std::fs::rename(p.dir.join("specseal"), p.dir.join("openspec")).unwrap();
    std::fs::create_dir_all(p.dir.join("openspec/changes/demo")).unwrap();
    std::fs::write(p.dir.join("openspec/changes/demo/.openspec.yaml"), "schema: spec-driven\n").unwrap();

    let out = p.run(&["workflow-config", "set", "worktree", "true"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(p.dir.join("openspec/changes/demo/.openspec.yaml").is_file(), "openspec/ 原封不动");
    assert!(!p.dir.join("specseal").exists());
    let skill = std::fs::read_to_string(p.dir.join(".claude/skills/specseal-apply-with-worktree/SKILL.md"))
        .expect("worktree skill generated");
    assert!(skill.contains("openspec/changes"), "技能档以 openspec/ 同步");
    assert!(p.dir.join(".claude/skills/specseal-worktree-merge/SKILL.md").is_file(), "两颗 worktree 技能都生成");
    let stdout = stdout_of(&out);
    assert!(!stdout.contains("Migrated") && !stdout.contains("migration"), "没有迁移提示: {stdout}");
}

#[test]
fn set_worktree_rejects_a_non_boolean_value() {
    // Spec scenario worktree 非法值报错.
    let p = TempProject::new("set-worktree-bad", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "worktree", "yes"]);
    assert!(!out.status.success(), "non-boolean value must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("worktree"), "stderr names the key: {err}");
    assert!(
        err.contains("true") && err.contains("false"),
        "stderr states the accepted values: {err}"
    );
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

#[test]
fn set_another_key_preserves_an_existing_worktree_value() {
    // 完整目标状态的回填缺口：编辑任一政策键都不得吃掉 worktree。
    let p = TempProject::new("set-keeps-worktree", "schema: spec-driven\nworktree: true\n");
    let out = p.run(&["workflow-config", "set", "audit", "true"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let after = p.config_text();
    assert!(after.contains("worktree: true"), "worktree survives: {after}");
    assert!(after.contains("audit: true"), "the edit landed: {after}");
}

#[test]
fn set_dry_run_prints_a_unified_diff_and_writes_nothing() {
    // Spec scenario dry-run 印 diff 不落档.
    let p = TempProject::new("set-dry-run", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "locale", "ja", "--dry-run"]);
    assert!(out.status.success(), "dry-run exits 0: {}", stderr_of(&out));
    let diff = stdout_of(&out);
    assert!(diff.contains("--- a/specseal/config.yaml"), "unified diff header: {diff}");
    assert!(diff.contains("+++ b/specseal/config.yaml"), "unified diff header: {diff}");
    assert!(diff.contains("@@"), "unified diff hunk: {diff}");
    assert!(diff.contains("-locale: tw"), "removed line: {diff}");
    assert!(diff.contains("+locale: ja"), "added line: {diff}");
    // 手术改写后 diff 收窄：除 locale 行外不得有其他 -/+ 变动行（不含整档重排）。
    let changed: Vec<&str> = diff
        .lines()
        .filter(|l| {
            (l.starts_with('-') || l.starts_with('+'))
                && !l.starts_with("---")
                && !l.starts_with("+++")
        })
        .collect();
    assert_eq!(changed, ["-locale: tw", "+locale: ja"], "only the locale line changes: {diff}");
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

#[test]
fn set_rejects_a_display_name_locale_value() {
    // Spec scenario 非法 locale 值拒绝（workflow-config-locale-validation）.
    let p = TempProject::new("set-bad-locale", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "locale", "繁体中文"]);
    assert!(!out.status.success(), "display-name value must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("locale"), "stderr names the key: {err}");
    assert!(err.contains("繁体中文"), "stderr echoes the received value: {err}");
    for code in ["tw", "ja", "en"] {
        assert!(err.contains(code), "stderr lists the accepted codes ({code}): {err}");
    }
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

#[test]
fn set_rejects_a_case_variant_locale_code() {
    // Spec Example 表：TW 拒绝（大小写敏感）.
    let p = TempProject::new("set-case-locale", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "locale", "TW"]);
    assert!(!out.status.success(), "case variant must exit non-zero");
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn set_dry_run_rejects_an_invalid_locale_without_a_diff() {
    // Spec scenario 非法值带 dry-run 同样拒绝.
    let p = TempProject::new("set-dry-bad-locale", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "spec_locale", "繁体中文", "--dry-run"]);
    assert!(!out.status.success(), "invalid value must exit non-zero even with --dry-run");
    assert!(!stdout_of(&out).contains("@@"), "no diff on stdout: {}", stdout_of(&out));
    let err = stderr_of(&out);
    for code in ["tw", "ja", "en", "auto"] {
        assert!(err.contains(code), "stderr lists the spec_locale codes ({code}): {err}");
    }
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn set_accepts_auto_for_spec_locale_and_empty_removes_the_key() {
    // Spec Example 表：spec_locale auto 成功；locale 空字符串 成功（移除键）.
    let p = TempProject::new("set-auto-and-empty", WF_YAML);
    let out = p.run(&["workflow-config", "set", "spec_locale", "auto"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(p.config_text().contains("spec_locale: auto"), "got: {}", p.config_text());
    let out = p.run(&["workflow-config", "set", "locale", ""]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(!p.config_text().contains("locale: tw"), "locale key removed: {}", p.config_text());
}

#[test]
fn set_refuses_to_rewrite_an_unparseable_config() {
    // Spec scenario 坏 config 拒绝写入.
    let p = TempProject::new("set-bad", BAD_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "set", "locale", "tw"]);
    assert!(!out.status.success(), "must exit non-zero on a broken config");
    let err = stderr_of(&out);
    assert!(err.contains("specseal/config.yaml"), "stderr names the file: {err}");
    assert!(err.contains("refused"), "stderr says the write was refused: {err}");
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

// --- context (fs) ---

#[test]
fn context_stdin_sets_the_multiline_value() {
    // Spec scenario context 设置多行内容.
    let p = TempProject::new("context-set", WF_YAML);
    let out = p.run_stdin(
        &["workflow-config", "context", "--stdin"],
        "## Project\n\nA rewritten description.\nSecond line.\n",
    );
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let after = p.config_text();
    assert!(after.contains("A rewritten description."), "context written: {after}");
    assert!(after.contains("Second line."), "every line written: {after}");
    assert!(!after.contains("Project context line one."), "old context replaced: {after}");
    assert!(after.contains("locale: tw"), "policy fields untouched: {after}");
    assert!(after.contains("tdd: true"), "policy fields untouched: {after}");
    assert!(after.contains("Name the crate boundary"), "rules untouched: {after}");
}

#[test]
fn context_blank_stdin_removes_the_key() {
    // Spec scenario 空白 stdin 移除 context.
    let p = TempProject::new("context-clear", WF_YAML);
    let out = p.run_stdin(&["workflow-config", "context", "--stdin"], "   \n\n");
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let after = p.config_text();
    assert!(!after.contains("context"), "context key removed: {after}");
    assert!(after.contains("locale: tw"), "policy fields untouched: {after}");
}

#[test]
fn context_without_the_stdin_flag_fails_with_usage() {
    // Spec: 两个子指令未带 --stdin 时以非零 exit code 说明用法.
    let p = TempProject::new("context-no-stdin", WF_YAML);
    let before = p.config_bytes();
    let out = p.run_stdin(&["workflow-config", "context"], "ignored\n");
    assert!(!out.status.success(), "missing --stdin must exit non-zero");
    assert!(
        stderr_of(&out).contains("--stdin"),
        "stderr states the usage: {}",
        stderr_of(&out)
    );
    assert_eq!(p.config_bytes(), before, "no file effect");
}

// --- rules (fs) ---

#[test]
fn rules_replaces_the_whole_section() {
    // Spec scenario rules 整节代换.
    let p = TempProject::new("rules-replace", WF_YAML);
    let out = p.run_stdin(
        &["workflow-config", "rules", "design", "--stdin"],
        "First rule\nSecond rule\nThird rule\n",
    );
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let after = p.run(&["workflow-config", "show", "--json"]);
    let payload = json_of(&after);
    assert_eq!(
        payload["rules"]["design"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["First rule", "Second rule", "Third rule"],
        "the section is replaced wholesale, not merged"
    );
    assert_eq!(
        payload["rules"]["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["Use checkbox format"],
        "other artifact sections are untouched"
    );
}

#[test]
fn rules_empty_stdin_removes_the_section() {
    // Spec: stdin 为空时移除该 artifact 节.
    let p = TempProject::new("rules-clear", WF_YAML);
    let out = p.run_stdin(&["workflow-config", "rules", "design", "--stdin"], "\n");
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let payload = json_of(&p.run(&["workflow-config", "show", "--json"]));
    assert!(payload["rules"]["design"].is_null(), "design section removed: {payload}");
    assert!(!payload["rules"]["tasks"].is_null(), "tasks section kept: {payload}");
}

#[test]
fn rules_rejects_an_artifact_outside_the_schema() {
    // Spec scenario 未知 artifact 拒绝.
    let p = TempProject::new("rules-unknown", WF_YAML);
    let before = p.config_bytes();
    let out = p.run_stdin(
        &["workflow-config", "rules", "blueprint", "--stdin"],
        "Anything\n",
    );
    assert!(!out.status.success(), "unknown artifact must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("blueprint"), "stderr names the artifact: {err}");
    assert!(err.contains("proposal"), "stderr lists the schema's artifacts: {err}");
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn rules_dry_run_prints_a_unified_diff_and_writes_nothing() {
    // Spec scenario rules dry-run 印 diff.
    let p = TempProject::new("rules-dry-run", WF_YAML);
    let before = p.config_bytes();
    let out = p.run_stdin(
        &["workflow-config", "rules", "tasks", "--stdin", "--dry-run"],
        "Only one rule now\n",
    );
    assert!(out.status.success(), "dry-run exits 0: {}", stderr_of(&out));
    let diff = stdout_of(&out);
    assert!(diff.contains("--- a/specseal/config.yaml"), "unified diff header: {diff}");
    assert!(diff.contains("@@"), "unified diff hunk: {diff}");
    assert!(diff.contains("+  - Only one rule now"), "added rule line: {diff}");
    assert!(diff.contains("-  - Use checkbox format"), "removed rule line: {diff}");
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

#[test]
fn dry_run_shows_lines_between_two_changes_as_context() {
    // Spec scenario 两处改动之间的未改行以 context 呈现＋Example rules.tasks 的差异.
    let p = TempProject::new(
        "dry-run-two-changes",
        "schema: spec-driven\nrules:\n  tasks:\n  - 甲\n  - 乙\n  - 丙\n",
    );
    let before = p.config_bytes();
    let out = p.run_stdin(
        &["workflow-config", "rules", "tasks", "--stdin", "--dry-run"],
        "甲二\n乙\n丙\n丁\n",
    );
    assert!(out.status.success(), "dry-run exits 0: {}", stderr_of(&out));
    let diff = stdout_of(&out);
    let hunk: Vec<&str> = diff.lines().skip_while(|l| !l.starts_with("@@")).skip(1).collect();
    assert_eq!(
        hunk,
        [" schema: spec-driven", " rules:", "   tasks:", "-  - 甲", "+  - 甲二", "   - 乙", "   - 丙", "+  - 丁"],
        "{diff}"
    );
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

// --- review (fs) ---

/// The `review` mapping of the config on disk, or None when the key is absent —
/// the typed `show --json` payload cannot tell an absent key from its defaults.
fn raw_review(p: &TempProject) -> Option<serde_yaml::Mapping> {
    let doc: serde_yaml::Mapping = serde_yaml::from_str(&p.config_text()).expect("config parses");
    doc.get("review").map(|v| v.as_mapping().expect("review is a mapping").clone())
}

fn review_json(p: &TempProject) -> serde_json::Value {
    let out = p.run(&["workflow-config", "show", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    json_of(&out)["review"].clone()
}

fn strings(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("expected a string array: {v}"))
        .iter()
        .map(|s| s.as_str().expect("string entry").to_string())
        .collect()
}

#[test]
fn review_lists_replace_wholesale_with_a_one_line_summary() {
    // Spec scenario 清单整段代换：一行一条、头尾空白去除、空行略过；其他键逐比特不变。
    let prefix = "schema: spec-driven\nlocale: tw\n";
    for list in ["critical", "warning", "suggestion"] {
        let p = TempProject::new(
            &format!("review-replace-{list}"),
            &format!("{prefix}review:\n  {list}:\n    - old rule\n"),
        );
        let out = p.run_stdin(
            &["workflow-config", "review", list, "--stdin"],
            "  rule one  \n\nrule two\n",
        );
        assert!(out.status.success(), "stderr: {}", stderr_of(&out));
        assert_eq!(stdout_of(&out), format!("✓ review.{list} = 2 entries\n"));
        assert_eq!(strings(&review_json(&p)[list]), ["rule one", "rule two"]);
        assert!(p.config_text().starts_with(prefix), "other keys untouched: {}", p.config_text());
    }
}

#[test]
fn review_writes_match_the_spec_example_table() {
    // Spec Example 写入效果与成功消息——逐列对应。
    struct Row {
        before: &'static str,
        args: &'static [&'static str],
        stdin: &'static str,
        stdout: &'static str,
        check: fn(Option<serde_yaml::Mapping>),
    }
    fn keys(m: &serde_yaml::Mapping) -> Vec<&str> {
        m.keys().map(|k| k.as_str().unwrap()).collect()
    }
    let rows = [
        Row {
            before: "schema: spec-driven\n",
            args: &["review", "warning", "--stdin"],
            stdin: "one rule\n",
            stdout: "✓ review.warning = 1 entries\n",
            check: |r| assert_eq!(keys(&r.expect("review written")), ["warning"]),
        },
        Row {
            before: "schema: spec-driven\nreview:\n  warning:\n    - w\n",
            args: &["review", "warning", "--stdin"],
            stdin: "",
            stdout: "✓ review.warning removed\n",
            check: |r| assert!(r.is_none(), "review key removed: {r:?}"),
        },
        Row {
            before: "schema: spec-driven\nreview:\n  critical:\n    - c\n",
            args: &["review", "baseline", "replace"],
            stdin: "",
            stdout: "✓ review.baseline = replace\n",
            check: |r| {
                let r = r.expect("review kept");
                assert_eq!(r.get("baseline"), Some(&"replace".into()));
                assert!(r.contains_key("critical"));
            },
        },
        Row {
            before: "schema: spec-driven\nreview:\n  baseline: replace\n  critical:\n    - c\n",
            args: &["review", "baseline", "extend"],
            stdin: "",
            stdout: "✓ review.baseline = extend (default)\n",
            check: |r| assert_eq!(keys(&r.expect("review kept")), ["critical"]),
        },
        Row {
            before: "schema: spec-driven\nreview:\n  baseline: replace\n",
            args: &["review", "baseline", "extend"],
            stdin: "",
            stdout: "✓ review.baseline = extend (default)\n",
            check: |r| assert!(r.is_none(), "review key removed: {r:?}"),
        },
    ];
    for (i, row) in rows.iter().enumerate() {
        let p = TempProject::new(&format!("review-table-{i}"), row.before);
        let mut args = vec!["workflow-config"];
        args.extend_from_slice(row.args);
        let out = p.run_stdin(&args, row.stdin);
        assert!(out.status.success(), "row {i} stderr: {}", stderr_of(&out));
        assert_eq!(stdout_of(&out), row.stdout, "row {i}");
        (row.check)(raw_review(&p));
    }
}

#[test]
fn review_list_without_the_stdin_flag_fails_with_usage() {
    // Spec scenario 未带 --stdin 说明用法.
    let p = TempProject::new("review-no-stdin", WF_YAML);
    let before = p.config_bytes();
    let out = p.run_stdin(&["workflow-config", "review", "critical"], "ignored\n");
    assert!(!out.status.success(), "missing --stdin must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("review critical --stdin"), "stderr states the usage: {err}");
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn review_rejects_an_unknown_list_or_baseline_value_listing_the_legal_ones() {
    // Spec scenario 不认得的清单名或 baseline 值.
    let p = TempProject::new("review-unknown", WF_YAML);
    let before = p.config_bytes();
    let out = p.run_stdin(&["workflow-config", "review", "blocker", "--stdin"], "x\n");
    assert!(!out.status.success(), "unknown list must exit non-zero");
    let err = stderr_of(&out);
    for legal in ["critical", "warning", "suggestion", "baseline"] {
        assert!(err.contains(legal), "stderr lists {legal}: {err}");
    }
    let out = p.run(&["workflow-config", "review", "baseline", "keep"]);
    assert!(!out.status.success(), "unknown baseline must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("extend") && err.contains("replace"), "stderr lists the values: {err}");
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn review_dry_run_prints_a_unified_diff_and_writes_nothing() {
    // Spec scenario dry-run 印 diff：只显示 review 区块的变更.
    let p = TempProject::new("review-dry-run", WF_YAML);
    let before = p.config_bytes();
    let out = p.run_stdin(
        &["workflow-config", "review", "suggestion", "--stdin", "--dry-run"],
        "Prefer small functions\n",
    );
    assert!(out.status.success(), "dry-run exits 0: {}", stderr_of(&out));
    let diff = stdout_of(&out);
    assert!(diff.contains("--- a/specseal/config.yaml"), "unified diff header: {diff}");
    let changed: Vec<&str> = diff
        .lines()
        .filter(|l| {
            (l.starts_with('-') || l.starts_with('+'))
                && !l.starts_with("---")
                && !l.starts_with("+++")
        })
        .collect();
    assert_eq!(
        changed,
        ["+", "+review:", "+  suggestion:", "+  - Prefer small functions"],
        "only the review block is added: {diff}"
    );
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

#[test]
fn review_reserved_char_entry_round_trips_verbatim() {
    // Spec scenario 保留字符开头的条目自动加引号.
    let p = TempProject::new("review-reserved", WF_YAML);
    let out = p.run_stdin(&["workflow-config", "review", "warning", "--stdin"], "@team 要审过\n");
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(strings(&review_json(&p)["warning"]), ["@team 要审过"]);
}

#[test]
fn review_refuses_to_rewrite_an_unparseable_config() {
    // Spec scenario 坏档拒写：YAML 语法错误与 review 子键打错皆拒写。
    for (tag, yaml) in [("syntax", BAD_YAML), ("typo", "review:\n  critcal:\n    - x\n")] {
        let p = TempProject::new(&format!("review-bad-{tag}"), yaml);
        let before = p.config_bytes();
        let out = p.run_stdin(&["workflow-config", "review", "critical", "--stdin"], "x\n");
        assert!(!out.status.success(), "{tag}: must exit non-zero");
        let err = stderr_of(&out);
        assert!(err.contains("specseal/config.yaml"), "{tag}: stderr names the file: {err}");
        assert!(err.contains("write refused"), "{tag}: stderr says the write is refused: {err}");
        assert_eq!(p.config_bytes(), before, "{tag}: no file effect");
    }
}

#[test]
fn show_prints_the_review_line_after_rules() {
    // Spec scenario 人眼输出的 review 行：rules 行之后恰一行、其余各行逐比特不变。
    let p = TempProject::new("show-review-none", WF_YAML);
    let out = p.run(&["workflow-config", "show", "--no-color"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        stdout_of(&out),
        "Workflow config: specseal/config.yaml\n\n  schema       spec-driven\n  locale       tw\n  spec_locale  unset (specs in English)\n  tdd          on\n  audit        unset (off)\n  worktree     unset (off)\n  context      2 lines\n  rules        design 2, tasks 1\n  review       none\n"
    );
    // Spec Example review 行的值.
    for (tag, review, value) in [
        (
            "counts",
            "review:\n  critical:\n    - a\n    - b\n  warning:\n    - c\n  suggestion:\n    - d\n",
            "extend, critical 2, warning 1, suggestion 1",
        ),
        ("replace", "review:\n  baseline: replace\n", "replace, critical 0, warning 0, suggestion 0"),
    ] {
        let p = TempProject::new(&format!("show-review-{tag}"), &format!("schema: spec-driven\n{review}"));
        let out = p.run(&["workflow-config", "show", "--no-color"]);
        assert!(out.status.success(), "stderr: {}", stderr_of(&out));
        let text = stdout_of(&out);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.last(), Some(&format!("  review       {value}").as_str()), "{text}");
        assert!(lines[lines.len() - 2].starts_with("  rules "), "review follows rules: {text}");
    }
}

#[test]
fn show_prints_the_project_default_schema() {
    // Spec scenario 显示项目缺省 schema ＋ Example schema 的值：人眼输出在 locale 行之前
    // 恰一行 schema、标签栏宽与 locale 行相同；--json 的 schema 未设置为 null。
    for (tag, schema_line, human, json) in [
        ("unset", "", "unset (spec-driven)", serde_json::Value::Null),
        ("builtin", "schema: spec-driven\n", "spec-driven", serde_json::json!("spec-driven")),
        ("custom", "schema: my-flow\n", "my-flow", serde_json::json!("my-flow")),
    ] {
        let p = TempProject::new(&format!("show-schema-{tag}"), &format!("{schema_line}locale: tw\n"));
        let out = p.run(&["workflow-config", "show", "--no-color"]);
        assert!(out.status.success(), "{tag}: stderr: {}", stderr_of(&out));
        let text = stdout_of(&out);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[2], format!("  schema       {human}"), "{tag}: {text}");
        assert_eq!(lines[3], "  locale       tw", "{tag}: schema precedes locale: {text}");
        assert_eq!(
            lines.iter().filter(|l| l.trim_start().starts_with("schema ")).count(),
            1,
            "{tag}: exactly one schema line: {text}"
        );

        let payload = json_of(&p.run(&["workflow-config", "show", "--json"]));
        assert_eq!(payload["schema"], json, "{tag}: {payload}");
    }
}

#[test]
fn show_json_carries_the_review_object() {
    // Spec scenario --json 带出 review 内容；未写时为默认值、字段恒存在。
    let p = TempProject::new("show-review-json-default", WF_YAML);
    assert_eq!(
        review_json(&p),
        serde_json::json!({"baseline": "extend", "critical": [], "warning": [], "suggestion": []})
    );
    let p = TempProject::new(
        "show-review-json",
        "review:\n  baseline: replace\n  critical:\n    - 所有 SQL 一律用参数化查找\n",
    );
    assert_eq!(
        review_json(&p),
        serde_json::json!({
            "baseline": "replace",
            "critical": ["所有 SQL 一律用参数化查找"],
            "warning": [],
            "suggestion": []
        })
    );
}

#[test]
fn a_review_typo_fails_show_and_instructions_closed() {
    // Spec scenario 子键打错即 fail-closed ＋ 其他指令同样 fail-closed.
    let p = TempProject::new("review-typo-show", "review:\n  critcal:\n    - x\n");
    let out = p.run(&["workflow-config", "show"]);
    assert!(!out.status.success(), "show must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("specseal/config.yaml") && err.contains("critcal"), "{err}");
    assert!(stdout_of(&out).trim().is_empty(), "no stdout: {}", stdout_of(&out));
    let p = TempProject::new("review-typo-instructions", "review:\n  baseline: keep\n");
    let change = p.dir.join("specseal").join("changes").join("any-change");
    std::fs::create_dir_all(&change).unwrap();
    std::fs::write(change.join(".meta.yaml"), "schema: spec-driven\ncreated: 2026-10-14\n").unwrap();
    let out = p.run(&["instructions", "proposal", "--change", "any-change", "--json"]);
    assert!(!out.status.success(), "instructions must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("specseal/config.yaml") && err.contains("keep"), "{err}");
    assert!(stdout_of(&out).trim().is_empty(), "no default payload: {}", stdout_of(&out));
}

// --- subagent_model: show (fs) ---

/// The spec scenario's block: two review cells, one verify cell, one custom list.
const SUBAGENT_YAML: &str = "\
subagent_model:
  review:
    claude: opus
    codex: gpt-6.1-sol
  verify:
    claude: sonnet
  choices:
    codex:
      - gpt-6.1-sol
      - gpt-6-astra
";

fn show_json_of(p: &TempProject) -> serde_json::Value {
    let out = p.run(&["workflow-config", "show", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    json_of(&out)
}

#[test]
fn show_json_carries_empty_subagent_model_and_the_builtin_list_by_default() {
    // Spec scenario --json payload 形状＋未写 subagent_model 时为缺省：两个字段恒存在。
    let payload = show_json_of(&TempProject::new("show-subagent-default", WF_YAML));
    assert_eq!(payload["subagentModel"], serde_json::json!({"review": {}, "verify": {}, "choices": {}}));
    assert_eq!(
        payload["builtinSubagentModels"],
        serde_json::json!({"claude": ["sonnet", "opus", "haiku", "fable"]})
    );
    let keys: Vec<&str> = payload.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert!(!keys.contains(&"subagent_model"), "no snake_case keys: {keys:?}");
}

#[test]
fn show_json_carries_the_subagent_model_block() {
    // Spec scenario --json 带出子代理模型设置。
    let p = TempProject::new("show-subagent", &format!("{WF_YAML}{SUBAGENT_YAML}"));
    let payload = show_json_of(&p);
    let block = &payload["subagentModel"];
    assert_eq!(
        *block,
        serde_json::json!({
            "review": {"claude": "opus", "codex": "gpt-6.1-sol"},
            "verify": {"claude": "sonnet"},
            "choices": {"codex": ["gpt-6.1-sol", "gpt-6-astra"]}
        })
    );
    assert!(block["review"]["claude"].is_string() && block["choices"]["codex"].is_array());
    assert_eq!(payload["builtinSubagentModels"]["claude"].as_array().map(Vec::len), Some(4));
}

#[test]
fn show_human_output_does_not_show_the_subagent_model_block() {
    // Spec scenario 人眼输出不显示子代理模型设置：与删掉区块后的输出逐比特一致。
    let with = TempProject::new("show-subagent-human", &format!("{WF_YAML}{SUBAGENT_YAML}"));
    let without = TempProject::new("show-subagent-human-none", WF_YAML);
    let (a, b) = (with.run(&["workflow-config", "show", "--no-color"]), without.run(&["workflow-config", "show", "--no-color"]));
    assert!(a.status.success() && b.status.success(), "stderr: {} / {}", stderr_of(&a), stderr_of(&b));
    assert_eq!(stdout_of(&a), stdout_of(&b));
}

#[test]
fn subagent_model_is_read_only_from_the_spec_dir_config() {
    // Spec scenario 环境变量与 .specseal.yaml 不影响子代理模型。
    let p = TempProject::new("subagent-app-yaml", WF_YAML);
    std::fs::write(
        p.dir.join(".specseal.yaml"),
        "tools:\n  - claude\nsubagent_model:\n  review:\n    claude: opus\n",
    )
    .unwrap();
    let payload = show_json_of(&p);
    assert_eq!(payload["subagentModel"], serde_json::json!({"review": {}, "verify": {}, "choices": {}}));
}

// --- subagent_model: subagent-model 写入 (fs) ---

/// The `subagent_model` mapping of the config on disk, or None when the key is absent.
fn raw_subagent(p: &TempProject) -> Option<serde_yaml::Mapping> {
    let doc: serde_yaml::Mapping = serde_yaml::from_str(&p.config_text()).expect("config parses");
    doc.get("subagent_model").map(|v| v.as_mapping().expect("subagent_model is a mapping").clone())
}

#[test]
fn subagent_model_writes_match_the_spec_example_table() {
    // Spec Example 写入效果与成功消息——逐列对应。
    let rows: [(&str, &[&str], &str, &str, serde_json::Value); 6] = [
        (
            "schema: spec-driven\n",
            &["review", "claude", "opus"],
            "",
            "✓ subagent_model.review.claude = opus\n",
            serde_json::json!({"review": {"claude": "opus"}, "verify": {}, "choices": {}}),
        ),
        (
            "schema: spec-driven\nsubagent_model:\n  review:\n    claude: opus\n",
            &["review", "claude", "sonnet"],
            "",
            "✓ subagent_model.review.claude = sonnet\n",
            serde_json::json!({"review": {"claude": "sonnet"}, "verify": {}, "choices": {}}),
        ),
        (
            "schema: spec-driven\nsubagent_model:\n  review:\n    claude: opus\n  verify:\n    codex: gpt-6.1-sol\n",
            &["verify", "codex", ""],
            "",
            "✓ subagent_model.verify.codex removed\n",
            serde_json::json!({"review": {"claude": "opus"}, "verify": {}, "choices": {}}),
        ),
        (
            "schema: spec-driven\nsubagent_model:\n  review:\n    claude: opus\n",
            &["review", "claude", ""],
            "",
            "✓ subagent_model.review.claude removed\n",
            serde_json::json!({"review": {}, "verify": {}, "choices": {}}),
        ),
        (
            "schema: spec-driven\n",
            &["choices", "codex", "--stdin"],
            "  gpt-6.1-sol  \n\ngpt-6-astra\n",
            "✓ subagent_model.choices.codex = 2 entries\n",
            serde_json::json!({"review": {}, "verify": {}, "choices": {"codex": ["gpt-6.1-sol", "gpt-6-astra"]}}),
        ),
        (
            "schema: spec-driven\nsubagent_model:\n  choices:\n    codex:\n      - a\n      - b\n",
            &["choices", "codex", "--stdin"],
            "",
            "✓ subagent_model.choices.codex removed\n",
            serde_json::json!({"review": {}, "verify": {}, "choices": {}}),
        ),
    ];
    for (i, (before, args, stdin, stdout, want)) in rows.iter().enumerate() {
        let p = TempProject::new(&format!("subagent-table-{i}"), before);
        let mut argv = vec!["workflow-config", "subagent-model"];
        argv.extend_from_slice(args);
        let out = p.run_stdin(&argv, stdin);
        assert!(out.status.success(), "row {i} stderr: {}", stderr_of(&out));
        assert_eq!(stdout_of(&out), *stdout, "row {i}");
        assert_eq!(show_json_of(&p)["subagentModel"], *want, "row {i}");
    }
    // 第 4、6 列写完全空：整个 subagent_model 键被移除。
    for (i, before, args, stdin) in [
        (3, rows[3].0, rows[3].1, ""),
        (5, rows[5].0, rows[5].1, ""),
    ] {
        let p = TempProject::new(&format!("subagent-table-removed-{i}"), before);
        let mut argv = vec!["workflow-config", "subagent-model"];
        argv.extend_from_slice(args);
        assert!(p.run_stdin(&argv, stdin).status.success(), "row {i}");
        assert!(raw_subagent(&p).is_none(), "row {i}: the key is removed: {}", p.config_text());
    }
}

#[test]
fn subagent_model_write_keeps_the_other_cells_and_keys() {
    // Spec scenario 设置一格保留其他内容。
    let prefix = "schema: spec-driven\nlocale: tw\n";
    let p = TempProject::new("subagent-keep", &format!("{prefix}subagent_model:\n  verify:\n    claude: sonnet\n"));
    let out = p.run(&["workflow-config", "subagent-model", "review", "claude", "opus"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ subagent_model.review.claude = opus\n");
    assert_eq!(
        show_json_of(&p)["subagentModel"],
        serde_json::json!({"review": {"claude": "opus"}, "verify": {"claude": "sonnet"}, "choices": {}})
    );
    assert!(p.config_text().starts_with(prefix), "other keys untouched: {}", p.config_text());
}

#[test]
fn subagent_model_accepts_any_kebab_case_tool() {
    // Spec scenario 写入的名称可以是任何 kebab-case 工具（.specseal.yaml 只激活 claude）。
    let p = TempProject::new("subagent-any-tool", WF_YAML);
    let out = p.run(&["workflow-config", "subagent-model", "review", "my-agent", "some-model"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(show_json_of(&p)["subagentModel"]["review"]["my-agent"], "some-model");
}

#[test]
fn subagent_model_rejects_an_unknown_form_or_a_non_kebab_tool() {
    // Spec scenario 不认得的形式或工具名称。
    let p = TempProject::new("subagent-unknown", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "subagent-model", "audit", "claude", "opus"]);
    assert!(!out.status.success(), "unknown form must exit non-zero");
    let err = stderr_of(&out);
    for legal in ["review", "verify", "choices"] {
        assert!(err.contains(legal), "stderr lists {legal}: {err}");
    }
    let out = p.run(&["workflow-config", "subagent-model", "review", "Claude", "opus"]);
    assert!(!out.status.success(), "a non-kebab tool must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("Claude") && err.contains("kebab-case"), "stderr names the rule: {err}");
    let out = p.run_stdin(&["workflow-config", "subagent-model", "choices", "Claude", "--stdin"], "a\n");
    assert!(!out.status.success(), "choices checks the tool name too: {}", stderr_of(&out));
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn subagent_model_choices_without_the_stdin_flag_fails_with_usage() {
    // Spec scenario choices 未带 --stdin 说明用法。
    let p = TempProject::new("subagent-no-stdin", WF_YAML);
    let before = p.config_bytes();
    let out = p.run_stdin(&["workflow-config", "subagent-model", "choices", "codex"], "ignored\n");
    assert!(!out.status.success(), "missing --stdin must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("subagent-model choices codex --stdin"), "stderr states the usage: {err}");
    assert_eq!(p.config_bytes(), before, "no file effect");
}

#[test]
fn subagent_model_dry_run_prints_a_unified_diff_and_writes_nothing() {
    // Spec scenario dry-run 印 diff：只显示 subagent_model 区块的变更。
    let p = TempProject::new("subagent-dry-run", WF_YAML);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "subagent-model", "verify", "claude", "sonnet", "--dry-run"]);
    assert!(out.status.success(), "dry-run exits 0: {}", stderr_of(&out));
    let diff = stdout_of(&out);
    assert!(diff.contains("--- a/specseal/config.yaml"), "unified diff header: {diff}");
    let changed: Vec<&str> = diff
        .lines()
        .filter(|l| (l.starts_with('-') || l.starts_with('+')) && !l.starts_with("---") && !l.starts_with("+++"))
        .collect();
    assert_eq!(
        changed,
        ["+", "+subagent_model:", "+  verify:", "+    claude: sonnet"],
        "only the subagent_model block is added: {diff}"
    );
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
}

#[test]
fn subagent_model_reserved_char_model_round_trips_verbatim() {
    // Spec：以 YAML 保留字符开头的模型名称自动加引号，读回逐字符一致。
    let p = TempProject::new("subagent-reserved", WF_YAML);
    let out = p.run(&["workflow-config", "subagent-model", "review", "claude", "@model"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(show_json_of(&p)["subagentModel"]["review"]["claude"], "@model");
}

#[test]
fn subagent_model_refuses_to_rewrite_an_unparseable_config() {
    // Spec scenario 坏档拒写：YAML 语法错误与 subagent_model 子键打错皆拒写。
    for (tag, yaml) in [("syntax", BAD_YAML), ("typo", "subagent_model:\n  reveiw:\n    claude: opus\n")] {
        let p = TempProject::new(&format!("subagent-bad-{tag}"), yaml);
        let before = p.config_bytes();
        let out = p.run(&["workflow-config", "subagent-model", "review", "claude", "opus"]);
        assert!(!out.status.success(), "{tag}: must exit non-zero");
        let err = stderr_of(&out);
        assert!(err.contains("specseal/config.yaml"), "{tag}: stderr names the file: {err}");
        assert!(err.contains("write refused"), "{tag}: stderr says the write is refused: {err}");
        assert_eq!(p.config_bytes(), before, "{tag}: no file effect");
    }
}

/// The exact stderr of a sub-agent model write's stale hint naming `tools`.
fn subagent_stale_hint(tools: &str) -> String {
    format!(
        "specseal: warning: skill files are older than this engine ({tools}; engine {ASSET_VERSION}) — an older quality-station skill may not apply this sub-agent model; run `specseal update`\n"
    )
}

#[test]
fn subagent_model_write_warns_when_skill_files_are_older_than_the_engine() {
    // Spec scenario 技能档过期时写入后提示（subagent-model 写入）。
    let p = TempProject::new("subagent-hint", WF_YAML);
    generate_skills(&p, &[(CLAUDE, OLD_SKILLS)]);
    let out = p.run(&["workflow-config", "subagent-model", "review", "claude", "opus"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ subagent_model.review.claude = opus\n");
    assert_eq!(stderr_of(&out), subagent_stale_hint(&format!("claude {OLD_SKILLS}")));
    let out = p.run_stdin(&["workflow-config", "subagent-model", "choices", "codex", "--stdin"], "a\n");
    assert_eq!(stderr_of(&out), subagent_stale_hint(&format!("claude {OLD_SKILLS}")), "choices writes warn too");
    // dry-run 不写入、不探测；技能档为现版时不提示。
    let out = p.run(&["workflow-config", "subagent-model", "verify", "claude", "sonnet", "--dry-run"]);
    assert!(!stderr_of(&out).contains(STALE_HINT), "no hint on dry-run: {}", stderr_of(&out));
    let current = TempProject::new("subagent-hint-current", WF_YAML);
    generate_skills(&current, &[]);
    let out = current.run(&["workflow-config", "subagent-model", "review", "claude", "opus"]);
    assert!(out.status.success() && !stderr_of(&out).contains(STALE_HINT), "current skills: {}", stderr_of(&out));
}

#[test]
fn subagent_model_write_that_changes_nothing_leaves_the_file_alone() {
    // Spec scenario 不改变内容的写入不动文件：区块内的注解与手写格式保留。
    let doc = "schema: spec-driven\nsubagent_model:\n  # team default\n  review: { claude: opus }   # hand-written\n";
    for (args, stdin, stdout) in [
        (&["subagent-model", "verify", "claude", ""][..], "", "✓ subagent_model.verify.claude unchanged\n"),
        (&["subagent-model", "review", "claude", "opus"][..], "", "✓ subagent_model.review.claude unchanged\n"),
        (&["subagent-model", "choices", "codex", "--stdin"][..], "", "✓ subagent_model.choices.codex unchanged\n"),
    ] {
        let p = TempProject::new("subagent-noop", doc);
        let before = p.config_bytes();
        let mut argv = vec!["workflow-config"];
        argv.extend_from_slice(args);
        let out = p.run_stdin(&argv, stdin);
        assert!(out.status.success(), "{args:?}: {}", stderr_of(&out));
        assert_eq!(stdout_of(&out), stdout, "{args:?}");
        assert_eq!(p.config_bytes(), before, "{args:?}: config.yaml is byte-for-byte unchanged");
    }
}

#[test]
fn a_subagent_model_typo_fails_show_closed() {
    // Spec scenario 子键打错即 fail-closed（以 workflow-config show 运行）。
    let p = TempProject::new("subagent-typo-show", "subagent_model:\n  reveiw:\n    claude: opus\n");
    let out = p.run(&["workflow-config", "show"]);
    assert!(!out.status.success(), "show must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("specseal/config.yaml") && err.contains("reveiw"), "{err}");
    assert!(stdout_of(&out).trim().is_empty(), "no stdout: {}", stdout_of(&out));
}

#[test]
fn subagent_model_help_lists_the_three_forms() {
    let p = TempProject::new("subagent-help", WF_YAML);
    let out = p.run(&["workflow-config", "subagent-model", "--help"]);
    assert!(out.status.success(), "help exits zero: {}", stderr_of(&out));
    let text = stdout_of(&out);
    for form in ["review", "verify", "choices"] {
        assert!(!table_row(&text, form).is_empty(), "help lists {form}: {text}");
    }
}

// --- help parity ---

/// The comma-separated list a "…: a, b, c" sentence ends with. Both the help
/// text and the unknown-key error are parsed through this ONE reader, so the
/// test never writes down its own copy of the policy keys — a third list would
/// just move the drift here.
fn keys_after_colon(text: &str) -> Vec<String> {
    let (_, list) = text.rsplit_once(": ").unwrap_or_else(|| {
        panic!("expected a '…: key, key' sentence: {text}");
    });
    list.trim().trim_end_matches('.').split(',').map(|k| k.trim().to_string()).collect()
}

/// The description clap renders above `Usage:` — everything before the first
/// blank line, whitespace collapsed so the assertion never depends on layout.
fn help_about(text: &str) -> String {
    let head: Vec<&str> = text.lines().take_while(|l| !l.trim().is_empty()).collect();
    head.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One entry of a clap table (`Commands:` or `Arguments:`): the matching row
/// plus any wrapped continuation lines (clap indents those deeper than the
/// entry column), whitespace collapsed. Wrap-safe so a longer key list can
/// never fail these tests over layout alone.
fn table_row(text: &str, name: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let idx = lines
        .iter()
        .position(|l| l.trim_start().starts_with(&format!("{name} ")) || l.trim_start() == name)
        .unwrap_or_else(|| panic!("no '{name}' row in the table: {text}"));
    let indent = lines[idx].len() - lines[idx].trim_start().len();
    let mut row = lines[idx].trim_start().to_string();
    for line in &lines[idx + 1..] {
        if line.trim().is_empty() || line.len() - line.trim_start().len() <= indent {
            break;
        }
        row.push(' ');
        row.push_str(line.trim_start());
    }
    row.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The rejection stderr of `set` with an unknown key — asserted to BE the
/// unknown-key error before anything parses it, so an unrelated failure
/// (fail-closed config, workspace discovery) can never masquerade as the
/// accepted-keys sentence.
fn unknown_key_stderr(p: &TempProject) -> String {
    let rejected = p.run(&["workflow-config", "set", "theme", "dark"]);
    assert!(!rejected.status.success(), "unknown key must exit non-zero");
    let err = stderr_of(&rejected).trim().to_string();
    assert!(err.contains("Unknown key"), "the rejection is the unknown-key error: {err}");
    err
}

#[test]
fn set_help_lists_exactly_the_accepted_policy_keys() {
    // Spec scenario set --help 列出全部政策键.
    let p = TempProject::new("set-help-keys", WF_YAML);
    let help = p.run(&["workflow-config", "set", "--help"]);
    assert!(help.status.success(), "help exits zero: {}", stderr_of(&help));

    let error_text = unknown_key_stderr(&p);
    let accepted = keys_after_colon(&error_text);
    let advertised = keys_after_colon(&help_about(&stdout_of(&help)));
    assert_eq!(
        advertised,
        accepted,
        "set --help must advertise exactly the keys the verb accepts\nhelp:  {}\nerror: {}",
        stdout_of(&help),
        error_text
    );

    // Help and the error sentence share one generator, so their equality alone
    // cannot catch an advertised key the verb no longer recognizes. Probe each
    // advertised key end-to-end: a junk value may be refused for its VALUE, but
    // never as an unknown KEY. (The reverse hole — a hidden key accepted but
    // advertised nowhere — has no list to probe from and stays out of scope.)
    for key in &advertised {
        let out = p.run(&["workflow-config", "set", key, "zzz", "--dry-run"]);
        let err = stderr_of(&out);
        assert!(
            !err.contains("Unknown key"),
            "advertised key '{key}' must be recognized by set: {err}"
        );
    }
}

#[test]
fn set_help_value_argument_names_every_boolean_key() {
    // Spec scenario set --help 标明布尔键的合法值.
    let p = TempProject::new("set-help-value", WF_YAML);
    let out = p.run(&["workflow-config", "set", "--help"]);
    assert!(out.status.success(), "help exits zero: {}", stderr_of(&out));
    let text = stdout_of(&out);
    // The `Usage:` line carries `<VALUE>` too — table_row only matches the
    // Arguments row (and absorbs a wrapped or next-line description).
    let row = table_row(&text, "<VALUE>");
    for key in ["tdd", "audit", "worktree"] {
        assert!(row.contains(key), "<VALUE> description names the boolean key {key}: {row}");
    }
    assert!(
        row.contains("true") && row.contains("false"),
        "<VALUE> description states the accepted values: {row}"
    );
}

#[test]
fn parent_help_and_set_help_share_one_set_description() {
    // Spec scenario 父层 help 的 set 说明同源.
    let p = TempProject::new("set-help-parent", WF_YAML);
    let parent = p.run(&["workflow-config", "--help"]);
    assert!(parent.status.success(), "help exits zero: {}", stderr_of(&parent));
    let child = p.run(&["workflow-config", "set", "--help"]);
    assert!(child.status.success(), "help exits zero: {}", stderr_of(&child));

    let row = table_row(&stdout_of(&parent), "set");
    let from_parent = row.split_once(' ').unwrap().1.to_string();
    let from_child = help_about(&stdout_of(&child));
    assert_eq!(from_parent, from_child, "both help surfaces read from one description");

    assert_eq!(
        keys_after_colon(&from_parent),
        keys_after_colon(&unknown_key_stderr(&p)),
        "the command list advertises every accepted key: {from_parent}"
    );
}

// --- review 写入后的技能档过期提示 ---
// Spec workflow-config「审查规则写入后的技能档过期提示」。

/// 旧于／新于引擎现版的技能版号（仿真以别版引擎生成的工作区；旧值取自规格 Example）。
const OLD_SKILLS: &str = "v1.44.0";
const NEWER_SKILLS: &str = "v999.0.0";

/// 两个工具的技能档所在（`<dir>/skills`）。
const CLAUDE: &str = ".claude";
const CODEX: &str = ".agents";

/// 过期提示的开头：不提示的情境只断言它不出现。
const STALE_HINT: &str = "specseal: warning: skill files are older";

/// The exact stderr of a stale hint naming `tools` (`<tool> <version>, …`).
fn stale_hint(tools: &str) -> String {
    format!(
        "specseal: warning: skill files are older than this engine ({tools}; engine {ASSET_VERSION}) — an older review skill may not apply these rules; run `specseal update`\n"
    )
}

/// Generate the declared tools' skills with `specseal update`, then restamp each
/// listed tool's skills as `(dir, version)`; unlisted tools stay current.
fn generate_skills(p: &TempProject, stamps: &[(&str, &str)]) {
    let out = p.run(&["update"]);
    assert!(out.status.success(), "update: {}", stderr_of(&out));
    for (dir, version) in stamps {
        set_skill_version(&p.dir.join(dir).join("skills"), version);
    }
}

#[test]
fn review_write_warns_when_skill_files_are_older_than_the_engine() {
    // Spec scenario 技能档过期时写入后提示＋Example 提示行（逐列）.
    let rows: [(&str, &[(&str, &str)], &str); 2] = [
        ("tools:\n  - claude\n", &[(CLAUDE, "v1.44.0")], "claude v1.44.0"),
        (
            "tools:\n  - claude\n  - codex\n",
            &[(CLAUDE, "v1.44.0"), (CODEX, "v1.43.0")],
            "claude v1.44.0, codex v1.43.0",
        ),
    ];
    for (i, (tools, stamps, named)) in rows.into_iter().enumerate() {
        let p = TempProject::new(&format!("stale-hint-{i}"), WF_YAML);
        std::fs::write(p.dir.join(".specseal.yaml"), tools).unwrap();
        generate_skills(&p, stamps);
        let out = p.run_stdin(&["workflow-config", "review", "warning", "--stdin"], "one rule\n");
        assert!(out.status.success(), "row {i} stderr: {}", stderr_of(&out));
        assert_eq!(stdout_of(&out), "✓ review.warning = 1 entries\n", "row {i}");
        assert_eq!(stderr_of(&out), stale_hint(named), "row {i}");
        assert_eq!(strings(&review_json(&p)["warning"]), ["one rule"], "row {i}");
    }
}

#[test]
fn the_hint_names_the_stale_tool_when_another_tool_is_missing() {
    // Spec scenario 一个工具缺失、另一个过期时仍提示过期的工具.
    let p = TempProject::new("stale-hint-missing", WF_YAML);
    std::fs::write(p.dir.join(".specseal.yaml"), "tools:\n  - claude\n  - codex\n").unwrap();
    generate_skills(&p, &[(CLAUDE, OLD_SKILLS)]);
    std::fs::remove_dir_all(p.dir.join(CODEX).join("skills")).unwrap();
    let out = p.run(&["workflow-config", "review", "baseline", "replace"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stderr_of(&out), stale_hint(&format!("claude {OLD_SKILLS}")));
}

#[test]
fn no_hint_when_skill_files_are_current_missing_or_newer() {
    // Spec scenarios 技能档现版或整组缺失时不提示＋工作区较新时不提示。最后一列
    // 有一个工具过期，整体仍为较新：钉住「整体较新就不提示」而非只看逐工具。
    let both = "tools:\n  - claude\n  - codex\n";
    let rows: [(&str, &str, Option<&[(&str, &str)]>, &str); 4] = [
        ("current", "tools:\n  - claude\n", Some(&[]), "critical"),
        ("missing", "tools:\n  - claude\n", None, "critical"),
        ("newer", "tools:\n  - claude\n", Some(&[(CLAUDE, NEWER_SKILLS)]), "suggestion"),
        ("newer+stale", both, Some(&[(CLAUDE, NEWER_SKILLS), (CODEX, OLD_SKILLS)]), "suggestion"),
    ];
    for (case, tools, stamps, list) in rows {
        let p = TempProject::new(&format!("hint-{case}"), WF_YAML);
        std::fs::write(p.dir.join(".specseal.yaml"), tools).unwrap();
        if let Some(stamps) = stamps {
            generate_skills(&p, stamps);
        }
        let out = p.run_stdin(&["workflow-config", "review", list, "--stdin"], "one rule\n");
        assert!(out.status.success(), "{case}: {}", stderr_of(&out));
        assert_eq!(stdout_of(&out), format!("✓ review.{list} = 1 entries\n"), "{case}");
        assert!(!stderr_of(&out).contains(STALE_HINT), "{case}: {}", stderr_of(&out));
    }
}

#[test]
fn no_hint_on_dry_run_or_non_review_writes() {
    // Spec scenario dry-run 与其他写入子指令不提示.
    let p = TempProject::new("hint-other-writes", WF_YAML);
    generate_skills(&p, &[(CLAUDE, OLD_SKILLS)]);
    let before = p.config_bytes();
    let out = p.run_stdin(
        &["workflow-config", "review", "warning", "--stdin", "--dry-run"],
        "one rule\n",
    );
    assert!(out.status.success(), "dry-run: {}", stderr_of(&out));
    assert!(!stderr_of(&out).contains(STALE_HINT), "dry-run: {}", stderr_of(&out));
    assert_eq!(p.config_bytes(), before, "config.yaml is byte-for-byte unchanged");
    for (args, stdin) in [
        (&["workflow-config", "set", "tdd", "true"][..], ""),
        (&["workflow-config", "rules", "tasks", "--stdin"][..], "one rule\n"),
    ] {
        let out = p.run_stdin(args, stdin);
        assert!(out.status.success(), "{args:?}: {}", stderr_of(&out));
        assert!(!stderr_of(&out).contains(STALE_HINT), "{args:?}: {}", stderr_of(&out));
    }
}

// --- remote mode ---

#[derive(Clone, Debug)]
struct Captured {
    method: String,
    path: String,
    body: String,
}

struct MockServer {
    server: Arc<tiny_http::Server>,
    base: String,
    captured: Arc<Mutex<Vec<Captured>>>,
}

const BINDING_BODY: &str = r#"{"actor":{"id":"u_1","name":"Tester"},"project":{"id":"prj_1","key":"demo","name":"Demo"},"repo":{"id":"repo_1","key":"backend","name":"Backend"},"apiVersion":"1","engineVersion":"0.1.0","capabilities":{"events":{"transports":[],"polling":{"url":"/sync-state","etag":true}}}}"#;

fn mock_server(mut routes: Vec<(&'static str, &'static str, u16, String)>) -> MockServer {
    if !routes.iter().any(|(_, suffix, _, _)| *suffix == "/binding") {
        routes.push(("GET", "/binding", 200, BINDING_BODY.to_string()));
    }
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("bind mock server"));
    let port = server.server_addr().to_ip().expect("ip").port();
    let base = format!("http://127.0.0.1:{port}/api/specseal/v1/projects/demo");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let looper = Arc::clone(&server);
    let sink = Arc::clone(&captured);
    std::thread::spawn(move || {
        for mut req in looper.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let path = req.url().split('?').next().unwrap_or_default().to_string();
            sink.lock().unwrap().push(Captured {
                method: req.method().to_string(),
                path: path.clone(),
                body,
            });
            let hit = routes.iter().find(|(m, suffix, _, _)| {
                req.method().to_string() == *m
                    && path == format!("/api/specseal/v1/projects/demo{suffix}")
            });
            let (status, body) = match hit {
                Some((_, _, status, body)) => (*status, body.clone()),
                None => (
                    404,
                    r#"{"reason":"not_found","message":"no route","resource":"route","name":"?"}"#
                        .to_string(),
                ),
            };
            let resp = tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
            let _ = req.respond(resp);
        }
    });
    MockServer { server, base, captured }
}

impl MockServer {
    fn find(&self, method: &str, path_suffix: &str) -> Captured {
        let caps = self.captured.lock().unwrap();
        caps.iter()
            .find(|c| {
                c.method == method
                    && c.path == format!("/api/specseal/v1/projects/demo{path_suffix}")
            })
            .unwrap_or_else(|| panic!("no captured {method} {path_suffix}; got {caps:?}"))
            .clone()
    }

    fn none(&self, method: &str, path_suffix: &str) -> bool {
        let caps = self.captured.lock().unwrap();
        !caps.iter().any(|c| {
            c.method == method && c.path == format!("/api/specseal/v1/projects/demo{path_suffix}")
        })
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

struct RemoteProject {
    dir: PathBuf,
}

impl RemoteProject {
    fn new(tag: &str, url: &str) -> RemoteProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-workflow-config-remote-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".specseal.yaml"),
            format!("remote:\n  url: {url}\n  repo: backend\n"),
        )
        .unwrap();
        RemoteProject { dir }
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(args)
            .current_dir(&self.dir)
            .env("NO_COLOR", "1")
            .env("SPECSEAL_TOKEN", "tok");
        for key in [
            "SPECSEAL_LOCALE",
            "SPECSEAL_SPEC_LOCALE",
            "SPECSEAL_TDD",
            "SPECSEAL_AUDIT",
            "SPECSEAL_WORKTREE",
            "SPECSEAL_STORE_URL",
        ] {
            cmd.env_remove(key);
        }
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().expect("run specseal binary")
    }

    fn run_stdin(&self, args: &[&str], stdin: &str) -> Output {
        run_with_stdin(self.cmd(args), stdin)
    }
}

impl Drop for RemoteProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// `GET /config` body carrying the fs fixture document at revision 7.
fn config_response() -> String {
    serde_json::json!({
        "schema": "spec-driven",
        "content": WF_YAML,
        "revision": 7,
    })
    .to_string()
}

#[test]
fn remote_show_json_has_the_same_shape_as_fs() {
    // Spec scenario remote 模式输出形状一致.
    let mock = mock_server(vec![("GET", "/config", 200, config_response())]);
    let p = RemoteProject::new("show", &mock.base);
    let out = p.run(&["workflow-config", "show", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let remote = json_of(&out);

    let fs = TempProject::new("remote-shape", WF_YAML);
    let fs_out = fs.run(&["workflow-config", "show", "--json"]);
    assert!(fs_out.status.success(), "stderr: {}", stderr_of(&fs_out));
    assert_eq!(remote, json_of(&fs_out), "remote and fs payloads are identical");
}

#[test]
fn remote_set_reads_then_writes_back_with_the_read_revision() {
    // Spec: remote 先读 server 端现行内容与版本、套用同一改写、写回时附带读得的版本.
    let mock = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        ("PUT", "/config", 200, r#"{"revision":8}"#.into()),
    ]);
    let p = RemoteProject::new("set", &mock.base);
    let out = p.run(&["workflow-config", "set", "audit", "true"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));

    let put = mock.find("PUT", "/config");
    let body: serde_json::Value = serde_json::from_str(&put.body).expect("PUT body is JSON");
    assert_eq!(body["expectedRevision"], 7, "the read revision guards the write");
    let content = body["content"].as_str().expect("content string");
    assert!(content.contains("audit: true"), "the edit landed: {content}");
    assert!(content.contains("locale: tw"), "other keys preserved: {content}");
    assert!(
        !stdout_of(&out).contains('7') && !stdout_of(&out).contains("revision"),
        "the revision never surfaces in the command output: {}",
        stdout_of(&out)
    );
}

#[test]
fn remote_context_write_round_trips_through_show() {
    // Spec scenario remote context 写入经版本检查.
    let mock = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        ("PUT", "/config", 200, r#"{"revision":8}"#.into()),
    ]);
    let p = RemoteProject::new("context", &mock.base);
    let out = p.run_stdin(
        &["workflow-config", "context", "--stdin"],
        "Remote project description.\n",
    );
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let put = mock.find("PUT", "/config");
    let body: serde_json::Value = serde_json::from_str(&put.body).expect("PUT body is JSON");
    let content = body["content"].as_str().expect("content string");
    assert!(
        content.contains("Remote project description."),
        "context written to the server document: {content}"
    );
}

#[test]
fn remote_revision_conflict_asks_for_a_rerun_without_overwriting() {
    // Spec scenario remote 版本冲突提示重跑.
    let mock = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        (
            "PUT",
            "/config",
            409,
            r#"{"status":409,"reason":"revision_conflict","message":"stale write"}"#.into(),
        ),
    ]);
    let p = RemoteProject::new("conflict", &mock.base);
    let out = p.run(&["workflow-config", "set", "tdd", "true"]);
    assert!(!out.status.success(), "a CAS refusal must exit non-zero");
    let err = stderr_of(&out);
    assert!(
        err.contains("updated by someone else") && err.contains("re-run"),
        "stderr explains the conflict and the fix: {err}"
    );
}

#[test]
fn remote_dry_run_prints_the_diff_without_writing() {
    // Spec: --dry-run 行为与 fs 一致（remote 亦不送出写入）.
    let mock = mock_server(vec![("GET", "/config", 200, config_response())]);
    let p = RemoteProject::new("dry-run", &mock.base);
    let out = p.run(&["workflow-config", "set", "locale", "ja", "--dry-run"]);
    assert!(out.status.success(), "dry-run exits 0: {}", stderr_of(&out));
    let diff = stdout_of(&out);
    assert!(diff.contains("@@"), "unified diff hunk: {diff}");
    assert!(diff.contains("+locale: ja"), "added line: {diff}");
    assert!(mock.none("PUT", "/config"), "dry-run sends no write request");
}

#[test]
fn remote_review_write_warns_from_the_local_skill_files() {
    // Spec scenario remote 模式以本机工作区判定.
    let mock = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        ("PUT", "/config", 200, r#"{"revision":8}"#.into()),
    ]);
    let p = RemoteProject::new("stale-hint", &mock.base);
    // remote fixture 缺省没有 tools 清单（探测视为没有受管工具），补上 claude。
    let yaml = p.dir.join(".specseal.yaml");
    let declared = std::fs::read_to_string(&yaml).unwrap() + "tools:\n  - claude\n";
    std::fs::write(&yaml, declared).unwrap();
    write_skill_file(&p.dir.join(CLAUDE).join("skills"), "specseal-review", OLD_SKILLS);

    let out = p.run_stdin(&["workflow-config", "review", "critical", "--stdin"], "one rule\n");

    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ review.critical = 1 entries\n");
    assert!(
        stderr_of(&out).contains(&stale_hint(&format!("claude {OLD_SKILLS}"))),
        "stderr carries the hint naming claude: {}",
        stderr_of(&out)
    );
}

#[test]
fn remote_subagent_model_write_reads_then_writes_back_with_the_read_revision() {
    // Spec scenario remote 写入经版本检查。
    let mock = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        ("PUT", "/config", 200, r#"{"revision":8}"#.into()),
    ]);
    let p = RemoteProject::new("subagent", &mock.base);
    let out = p.run(&["workflow-config", "subagent-model", "review", "claude", "opus"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ subagent_model.review.claude = opus\n");
    let put = mock.find("PUT", "/config");
    let body: serde_json::Value = serde_json::from_str(&put.body).expect("PUT body is JSON");
    assert_eq!(body["expectedRevision"], 7, "the read revision guards the write");
    let content = body["content"].as_str().expect("content string");
    let doc: serde_yaml::Value = serde_yaml::from_str(content).expect("content parses");
    assert_eq!(doc["subagent_model"]["review"]["claude"], serde_yaml::Value::from("opus"), "{content}");
    assert!(content.contains("locale: tw"), "other keys preserved: {content}");
    // 后续 show --json 读回同一内容：server 端此后回传刚写入的文档。
    let after = mock_server(vec![(
        "GET",
        "/config",
        200,
        serde_json::json!({"schema": "spec-driven", "content": content, "revision": 8}).to_string(),
    )]);
    let reader = RemoteProject::new("subagent-readback", &after.base);
    let out = reader.run(&["workflow-config", "show", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        json_of(&out)["subagentModel"],
        serde_json::json!({"review": {"claude": "opus"}, "verify": {}, "choices": {}})
    );
}

#[test]
fn remote_subagent_model_conflict_asks_for_a_rerun() {
    // Spec scenario remote 版本冲突。
    let mock = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        (
            "PUT",
            "/config",
            409,
            r#"{"status":409,"reason":"revision_conflict","message":"stale write"}"#.into(),
        ),
    ]);
    let p = RemoteProject::new("subagent-conflict", &mock.base);
    let out = p.run_stdin(&["workflow-config", "subagent-model", "choices", "codex", "--stdin"], "gpt-6.1-sol\n");
    assert!(!out.status.success(), "a CAS refusal must exit non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("updated by someone else") && err.contains("re-run"), "stderr explains the conflict: {err}");
}

#[test]
fn remote_subagent_model_write_warns_from_the_local_skill_files() {
    // Spec：subagent-model 写入的过期提示在 remote 模式同样以本机工作区判定。
    let mock = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        ("PUT", "/config", 200, r#"{"revision":8}"#.into()),
    ]);
    let p = RemoteProject::new("subagent-stale-hint", &mock.base);
    let yaml = p.dir.join(".specseal.yaml");
    let declared = std::fs::read_to_string(&yaml).unwrap() + "tools:\n  - claude\n";
    std::fs::write(&yaml, declared).unwrap();
    write_skill_file(&p.dir.join(CLAUDE).join("skills"), "specseal-review", OLD_SKILLS);

    let out = p.run(&["workflow-config", "subagent-model", "review", "claude", "opus"]);

    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ subagent_model.review.claude = opus\n");
    assert!(
        stderr_of(&out).contains(&subagent_stale_hint(&format!("claude {OLD_SKILLS}"))),
        "stderr carries the hint naming claude: {}",
        stderr_of(&out)
    );
}

#[test]
fn remote_offline_fails_semantically_without_queueing() {
    // Spec: 连接脱机时以非零 exit code 失败并输出语义化消息，不暂存或排队写入.
    let mock = mock_server(vec![("GET", "/config", 200, config_response())]);
    let base = mock.base.clone();
    let p = RemoteProject::new("offline", &base);
    drop(mock); // server gone — the connection is refused
    let out = p.run(&["workflow-config", "set", "tdd", "true"]);
    assert!(!out.status.success(), "offline must exit non-zero");
    let err = stderr_of(&out);
    assert!(
        err.contains("unreachable") || err.contains("connection"),
        "stderr is a semantic connection failure: {err}"
    );
    assert!(
        !p.dir.join(".specseal").exists(),
        "nothing is queued or spooled locally"
    );
}

// --- worktree 政策闸：技能足迹随政策进出 ---
// Spec workspace-tools「worktree 技能的政策条件式生成」。

/// 受闸控技能于 claude 足迹下的目录（跨平台以分段 join，不写死分隔符）。
const GATED_SKILLS: [&str; 2] = [
    ".claude/skills/specseal-apply-with-worktree",
    ".claude/skills/specseal-worktree-merge",
];

fn dir_exists(p: &TempProject, rel: &str) -> bool {
    p.dir.join(rel.split('/').collect::<PathBuf>()).is_dir()
}

#[test]
fn update_generates_worktree_skills_only_while_the_policy_is_on() {
    // Scenario「政策打开时注入两颗技能」＋「政策由开改关后再生即清理」：同一个
    // fixture 走完开→关，证明 update 是收敛的（不是只在初次生成时判断）。
    let p = TempProject::new("gate-flip", "schema: spec-driven\nworktree: true\n");

    let out = p.run(&["update"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    for rel in GATED_SKILLS {
        assert!(dir_exists(&p, rel), "政策打开时须生成 {rel}");
    }

    std::fs::write(p.config_path(), "schema: spec-driven\n").unwrap();
    let out = p.run(&["update"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    for rel in GATED_SKILLS {
        assert!(!dir_exists(&p, rel), "政策关闭后须清理 {rel}");
    }
    // 其余技能不受影响；指令档一律不生成。
    assert!(dir_exists(&p, ".claude/skills/specseal-apply"), "非闸控技能须保留");
    assert!(!p.dir.join("CLAUDE.md").exists(), "指令档不得生成");
}

#[test]
fn the_worktree_env_override_does_not_affect_generation() {
    // Scenario「环境变量不影响生成」：env 是运行期逃生口，注入只跟档值走。
    let p = TempProject::new("gate-env", "schema: spec-driven\n");
    let out = p.run_env(&["update"], &[("SPECSEAL_WORKTREE", "true")]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    for rel in GATED_SKILLS {
        assert!(!dir_exists(&p, rel), "env 不得使 {rel} 被生成");
    }
}

// --- set worktree：写入后同步足迹，关闭前先挡活跃 worktree ---
// Spec workflow-config「worktree 字段写入的技能同步与关闭挡下」。

/// 把 fixture 变成一个真的 git 主 checkout（worktree 探索的前提）。
fn git_init(p: &TempProject) {
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(&p.dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.test")
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["add", "-A"]);
    git(&["commit", "-qm", "seed"]);
}

/// Attach a linked worktree on `specseal/<change>` with that change present in
/// both copies — the three conditions discovery requires for a mapping.
fn attach_worktree(p: &TempProject, change: &str) -> PathBuf {
    let change_dir = p.dir.join("specseal").join("changes").join(change);
    std::fs::create_dir_all(&change_dir).unwrap();
    std::fs::write(change_dir.join("proposal.md"), "## Why\n\nseed\n").unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(&p.dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.test")
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["add", "-A"]);
    git(&["commit", "-qm", "change"]);
    let wt = p.dir.join("wt");
    git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        &format!("specseal/{change}"),
        wt.to_str().unwrap(),
    ]);
    wt
}

#[test]
fn set_worktree_true_then_false_moves_the_skill_footprint_with_it() {
    // Scenario「set true 写入并注入技能」＋「set false 无活跃 worktree 时写入并清理」。
    let p = TempProject::new("set-wt-sync", "schema: spec-driven\n");

    let out = p.run(&["workflow-config", "set", "worktree", "true"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    for rel in GATED_SKILLS {
        assert!(dir_exists(&p, rel), "set true 后须注入 {rel}");
    }

    let out = p.run(&["workflow-config", "set", "worktree", "false"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    for rel in GATED_SKILLS {
        assert!(!dir_exists(&p, rel), "set false 后须清理 {rel}");
    }
}

#[test]
fn setting_another_policy_key_does_not_touch_the_skill_footprint() {
    // 同步只绑 worktree 键：改 locale 不该重写技能档（其他键的写入语意不变）。
    let p = TempProject::new("set-wt-scope", "schema: spec-driven\n");
    let out = p.run(&["workflow-config", "set", "locale", "ja"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(
        !dir_exists(&p, ".claude/skills/specseal-apply"),
        "非 worktree 键的写入不触发足迹生成"
    );
}

#[test]
fn set_worktree_false_is_refused_while_a_linked_worktree_is_active() {
    // Scenario「set false 遇活跃 worktree 拒绝」：非零 exit、stderr 列 change 名／
    // 分支／路径、config 字节不变、足迹不动。
    let p = TempProject::new("set-wt-blocked", "schema: spec-driven\n");
    git_init(&p);
    let out = p.run(&["workflow-config", "set", "worktree", "true"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let wt = attach_worktree(&p, "add-auth");
    let before = p.config_bytes();

    let out = p.run(&["workflow-config", "set", "worktree", "false"]);

    assert!(!out.status.success(), "有活跃 worktree 时须以非零 exit 拒绝");
    let err = stderr_of(&out);
    assert!(err.contains("add-auth"), "stderr 须列 change 名: {err}");
    assert!(err.contains("specseal/add-auth"), "stderr 须列分支: {err}");
    // 路径来自 `git worktree list`：git 在 Windows 以正斜线回报，且会把 %TMP% 的
    // 8.3 短名展开（RUNNERAD~1 → runneradmin），测试手上的 PathBuf 是反斜线＋短名。
    // 仅 Windows 走 canonicalize 展开短名并剥去 \\?\ 前缀（macOS 解 symlink 反而
    // 与 git 回报不同底）；拼法不是契约，指到同一个 worktree 才是。
    let wt = if cfg!(windows) { wt.canonicalize().expect("canonicalize worktree") } else { wt };
    let slashed = |s: &str| s.replace('\\', "/");
    let want = slashed(wt.to_str().unwrap());
    assert!(
        slashed(&err).contains(want.trim_start_matches("//?/")),
        "stderr 须列 worktree 路径: {err}"
    );
    assert!(err.contains("worktree-merge"), "stderr 须指出收尾方式: {err}");
    assert_eq!(p.config_bytes(), before, "拒绝时 config.yaml 字节不得变");
    for rel in GATED_SKILLS {
        assert!(dir_exists(&p, rel), "拒绝时足迹不得变动：{rel} 须仍在");
    }
}

#[test]
fn set_worktree_false_is_allowed_when_the_policy_is_already_off() {
    // 挡下的条件是「由 true 改 false」（spec 字面）——政策本来就关着时，
    // 技能本来就不在，残留的 worktree 没有「会被抽走收尾工具」的风险，
    // 这个 no-op 写入不得被挡。
    let p = TempProject::new("set-wt-noop", "schema: spec-driven\n");
    git_init(&p);
    attach_worktree(&p, "add-auth");

    let out = p.run(&["workflow-config", "set", "worktree", "false"]);

    assert!(
        out.status.success(),
        "政策已关时 set false 为 no-op，不得被挡：{}",
        stderr_of(&out)
    );
    // 写入默认值不落键（缺席＝false，既有政策写入语意），故看 show 的正典值。
    let payload = json_of(&p.run(&["workflow-config", "show", "--json"]));
    assert_eq!(payload["worktree"], false, "值仍为 false: {payload}");
}

#[test]
fn a_failed_skill_sync_keeps_the_config_write_and_points_at_update() {
    // Scenario「技能同步失败时 config 写入仍成立」（design D2 的半套语意）：
    // config 为正典、exit code 非 0、stderr 指向重跑 specseal update。
    let p = TempProject::new("set-wt-sync-fail", "schema: spec-driven\n");
    // 技能目录的位置摆一个同名文件，让足迹生成必败。
    let blocker = p.dir.join(".claude").join("skills");
    std::fs::create_dir_all(blocker.parent().unwrap()).unwrap();
    std::fs::write(&blocker, "not a directory").unwrap();

    let out = p.run(&["workflow-config", "set", "worktree", "true"]);

    assert!(!out.status.success(), "同步失败须以非零 exit 回报");
    let err = stderr_of(&out);
    assert!(err.contains("specseal update"), "stderr 须指向重跑 update: {err}");
    assert!(
        p.config_text().contains("worktree: true"),
        "config 已写入为正典：{}",
        p.config_text()
    );
}

// --- 值没有变的写入：不写档，也没有后续动作 ---
// Spec workflow-config「流程设置的写入经命令运行层」的 Scenario「值没有变时不同步技能
// 也不提示」与其 Example（逐列）。

#[test]
fn a_worktree_write_that_changes_nothing_does_not_sync_the_skills() {
    for (doc, value) in [("schema: spec-driven\nworktree: true\n", "true"), ("schema: spec-driven\n", "false")] {
        let p = TempProject::new(&format!("noop-wt-{value}"), doc);
        let out = p.run(&["workflow-config", "set", "worktree", value]);
        assert!(out.status.success(), "{value}: {}", stderr_of(&out));
        assert_eq!(stdout_of(&out), format!("✓ worktree = {value}\n"), "only the confirmation line");
        assert_eq!(p.config_text(), doc, "{value}: config.yaml is byte-for-byte unchanged");
        assert!(!p.dir.join(".claude").exists(), "{value}: no skill footprint is generated");
    }
}

#[test]
fn a_station_rule_write_that_changes_nothing_gives_no_stale_hint() {
    let p = TempProject::new("noop-hint", WF_YAML);
    generate_skills(&p, &[(CLAUDE, OLD_SKILLS)]);
    let before = p.config_bytes();
    let out = p.run(&["workflow-config", "review", "baseline", "extend"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ review.baseline = extend (default)\n");
    assert_eq!(stderr_of(&out), "", "nothing was written, so nothing is probed");
    let out = p.run(&["workflow-config", "subagent-model", "verify", "claude", ""]);
    assert_eq!(stdout_of(&out), "✓ subagent_model.verify.claude unchanged\n");
    assert_eq!(stderr_of(&out), "");
    assert_eq!(p.config_bytes(), before);
}

#[test]
fn a_write_that_changes_nothing_does_not_create_a_missing_config() {
    let p = TempProject::new("noop-absent", "");
    std::fs::remove_file(p.config_path()).unwrap();
    let out = p.run(&["workflow-config", "set", "tdd", "false"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ tdd = false\n");
    assert!(!p.config_path().exists(), "no empty config.yaml is created");
}

#[test]
fn rules_proposal_from_stdin_prints_and_writes_what_it_did_before_the_command_layer() {
    // Spec scenario「CLI 的输出与写出的文件不变」：stdout、stderr、exit code 与整份
    // config.yaml 的字节，都是变更前的 CLI 对同一份输入给出的结果。
    let p = TempProject::new("rules-proposal-frozen", WF_YAML);
    let out = p.run_stdin(&["workflow-config", "rules", "proposal", "--stdin"], "Rule one\n  Rule two  \n\n");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(stdout_of(&out), "✓ rules.proposal = 2 entries\n");
    assert_eq!(stderr_of(&out), "");
    assert_eq!(
        p.config_text(),
        "\
schema: spec-driven
locale: tw
tdd: true
context: |
  Project context line one.
  Line two.
rules:
  proposal:
  - Rule one
  - Rule two
  design:
  - Name the crate boundary
  - List one alternative
  tasks:
  - Use checkbox format
"
    );
}

#[test]
fn remote_write_that_changes_nothing_gives_no_stale_hint() {
    // 过期提示在两种模式都看变动的键：remote 模式照常送出写入，但审查规则没有变时不提示。
    let server = mock_server(vec![
        ("GET", "/config", 200, config_response()),
        ("PUT", "/config", 200, r#"{"revision":8}"#.to_string()),
    ]);
    let p = RemoteProject::new("remote-noop-hint", &server.base);
    // 与 remote_review_write_warns_from_the_local_skill_files 同一组前提：声明 claude、
    // 技能档旧于引擎——那个测试在规则有变时会提示。
    let yaml = p.dir.join(".specseal.yaml");
    let declared = std::fs::read_to_string(&yaml).unwrap() + "tools:\n  - claude\n";
    std::fs::write(&yaml, declared).unwrap();
    write_skill_file(&p.dir.join(CLAUDE).join("skills"), "specseal-review", OLD_SKILLS);
    let out = p.run(&["workflow-config", "review", "baseline", "extend", "--no-color"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(stdout_of(&out), "✓ review.baseline = extend (default)\n");
    assert!(!stderr_of(&out).contains(STALE_HINT), "nothing changed: {}", stderr_of(&out));
    assert!(!server.none("PUT", "/config"), "the remote arm still sends its write");
}
