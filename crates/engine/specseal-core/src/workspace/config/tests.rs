
#[test]
fn set_schema_overwrites_the_existing_key_and_preserves_every_other_byte() {
    let doc = "# lead comment\nschema: spec-driven\n\nlocale: tw\ncontext: |\n  line one\n";
    let out = super::set_workflow_schema_text(Some(doc), "my-flow").expect("rewrites");
    assert_eq!(out, "# lead comment\nschema: my-flow\n\nlocale: tw\ncontext: |\n  line one\n");
}

#[test]
fn set_schema_refuses_an_unparseable_document() {
    assert!(super::set_workflow_schema_text(Some(": not yaml : [\n"), "my-flow").is_err());
}
use super::*;

fn app(yaml: &str) -> AppConfig {
    serde_yaml::from_str(yaml).expect("app yaml")
}

fn wf(yaml: &str) -> WorkflowConfig {
    serde_yaml::from_str(yaml).expect("wf yaml")
}

fn env_of(pairs: &[(&str, &str)]) -> EnvOverrides {
    EnvOverrides::from_lookup(|key| {
        pairs
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.to_string())
    })
}

const NO_ENV: &[(&str, &str)] = &[];

// --- 注入形 lookup 是唯一 env 来源：process env 不可见 ---

#[test]
fn from_lookup_never_reads_the_process_environment() {
    std::env::set_var("SPECSEAL_AUDIT", "true");
    let env = EnvOverrides::from_lookup(|_| None);
    std::env::remove_var("SPECSEAL_AUDIT");
    assert_eq!(
        env.audit, None,
        "an empty injected lookup yields no overrides regardless of process env"
    );
}

// --- locale: env > config.yaml > default ---

#[test]
fn locale_env_var_wins_over_all_layers() {
    let p = resolve_policy(&env_of(&[("SPECSEAL_LOCALE", "ja")]), &wf("locale: en"));
    assert_eq!(p.locale, "Japanese (日本语)");
}

#[test]
fn locale_canonical_value_applies_without_upper_layers() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("locale: ja"));
    assert_eq!(p.locale, "Japanese (日本语)");
}

#[test]
fn locale_defaults_to_english() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("{}"));
    assert_eq!(p.locale, "English");
}

// --- spec_locale: env > config.yaml > default ---

#[test]
fn spec_locale_env_var_wins_over_all_layers() {
    let p = resolve_policy(&env_of(&[("SPECSEAL_SPEC_LOCALE", "ja")]), &wf("spec_locale: en"));
    assert_eq!(p.spec_locale.as_deref(), Some("ja"));
}

#[test]
fn spec_locale_canonical_value_applies_without_upper_layers() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("spec_locale: ja"));
    assert_eq!(p.spec_locale.as_deref(), Some("ja"));
}

#[test]
fn spec_locale_defaults_to_none() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("{}"));
    assert_eq!(p.spec_locale, None);
}

#[test]
fn spec_locale_auto_follows_resolved_locale() {
    // Existing "auto" semantics survive the extra env layer: auto follows the
    // locale resolved through the same three layers.
    let p = resolve_policy(&env_of(NO_ENV), &wf("locale: ja\nspec_locale: auto"));
    assert_eq!(p.spec_locale.as_deref(), Some("ja"));
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_LOCALE", "tw")]),
        &wf("locale: ja\nspec_locale: auto"),
    );
    assert_eq!(p.spec_locale.as_deref(), Some("tw"));
}

// --- tdd: env > config.yaml > default ---

#[test]
fn tdd_env_var_wins_over_all_layers() {
    // Spec scenario 环境变量覆写正典值: SPECSEAL_TDD=false beats both files' true.
    let p = resolve_policy(&env_of(&[("SPECSEAL_TDD", "false")]), &wf("tdd: true"));
    assert!(!p.tdd);
}

#[test]
fn tdd_canonical_value_applies_without_upper_layers() {
    // Spec scenario 正典值生效: only config.yaml sets tdd: true.
    let p = resolve_policy(&env_of(NO_ENV), &wf("tdd: true"));
    assert!(p.tdd);
}

#[test]
fn tdd_defaults_to_false() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("{}"));
    assert!(!p.tdd);
}

// --- audit: env > config.yaml > default ---

#[test]
fn audit_env_var_wins_over_all_layers() {
    let p = resolve_policy(&env_of(&[("SPECSEAL_AUDIT", "false")]), &wf("audit: true"));
    assert!(!p.audit);
}

#[test]
fn audit_canonical_value_applies_without_upper_layers() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("audit: true"));
    assert!(p.audit);
}

#[test]
fn audit_defaults_to_false() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("{}"));
    assert!(!p.audit);
}

// --- worktree: env > config.yaml > default ---

#[test]
fn worktree_canonical_value_applies_without_upper_layers() {
    // Spec scenario worktree 字段写入与呈现 (read side): config.yaml alone turns it on.
    let p = resolve_policy(&env_of(NO_ENV), &wf("worktree: true"));
    assert!(p.worktree);
}

#[test]
fn worktree_env_var_wins_over_canonical() {
    // Spec scenario SPECSEAL_WORKTREE 覆写文件值.
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_WORKTREE", "true")]),
        &wf("worktree: false"),
    );
    assert!(p.worktree);
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_WORKTREE", "false")]),
        &wf("worktree: true"),
    );
    assert!(!p.worktree);
}

#[test]
fn worktree_invalid_env_var_falls_to_next_layer() {
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_WORKTREE", "yes")]),
        &wf("worktree: true"),
    );
    assert!(p.worktree);
}

#[test]
fn worktree_defaults_to_false() {
    let p = resolve_policy(&env_of(NO_ENV), &wf("{}"));
    assert!(!p.worktree);
}

// --- boolean env vars: only true/false are accepted; anything else is unset ---

#[test]
fn invalid_bool_env_var_falls_to_next_layer() {
    // Spec scenario 非法布尔环境变量落到下一层: SPECSEAL_AUDIT=yes is ignored.
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_AUDIT", "yes")]),
        &wf("audit: true"),
    );
    assert!(p.audit);
    // Numeric truthiness is NOT a boolean here — "1"/"0" are unset too.
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_TDD", "1")]),
        &wf("tdd: false"),
    );
    assert!(!p.tdd);
    // An invalid env value falls to the canonical layer — the app key stays inert.
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_TDD", "yes")]),
        &wf("tdd: true"),
    );
    assert!(p.tdd);
}

#[test]
fn bool_env_var_is_case_insensitive_and_trimmed() {
    // A CI system exporting SPECSEAL_TDD=TRUE must not silently disable the
    // override (confused-developer trap): case and surrounding whitespace are
    // normalized before matching.
    let p = resolve_policy(
        &env_of(&[("SPECSEAL_TDD", " TRUE ")]),
        &wf("tdd: false"),
    );
    assert!(p.tdd);
}

#[test]
fn empty_string_env_vars_are_unset() {
    // `SPECSEAL_LOCALE=` (empty) must not shadow lower layers with emptiness.
    let p = resolve_policy(
        &env_of(&[
            ("SPECSEAL_LOCALE", ""),
            ("SPECSEAL_SPEC_LOCALE", "  "),
            ("SPECSEAL_TDD", ""),
        ]),
        &wf("locale: tw\nspec_locale: tw\ntdd: true"),
    );
    assert_eq!(p.locale, "Traditional Chinese (繁体中文)");
    assert_eq!(p.spec_locale.as_deref(), Some("tw"));
    assert!(p.tdd);
}

// --- serde compatibility ---

#[test]
fn workflow_config_parses_new_policy_fields() {
    let w = wf("tdd: true\naudit: false");
    assert_eq!(w.tdd, Some(true));
    assert_eq!(w.audit, Some(false));
}

#[test]
fn workflow_config_without_policy_fields_still_parses() {
    let w = WorkflowConfig::from_text(Some("schema: spec-driven\nlocale: tw")).expect("parses");
    assert_eq!(w.tdd, None);
    assert_eq!(w.audit, None);
    assert_eq!(w.worktree, None);
    assert_eq!(w.locale.as_deref(), Some("tw"));
}

#[test]
fn workflow_config_parses_worktree() {
    assert_eq!(wf("worktree: true").worktree, Some(true));
    assert_eq!(wf("worktree: false").worktree, Some(false));
}

// --- fail-closed loading: a present file must parse; only a MISSING file yields defaults ---

/// Throwaway dir for load() tests, removed on drop.
struct TempCfgDir {
    dir: std::path::PathBuf,
}

impl TempCfgDir {
    fn new(tag: &str) -> TempCfgDir {
        let dir = std::env::temp_dir().join(format!(
            "specseal-core-cfg-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempCfgDir { dir }
    }

    fn app_yaml(&self, content: &str) -> std::path::PathBuf {
        let path = self.dir.join(".specseal.yaml");
        std::fs::write(&path, content).unwrap();
        path
    }

    fn read_app_yaml(&self) -> String {
        std::fs::read_to_string(self.dir.join(".specseal.yaml")).unwrap()
    }
}

impl Drop for TempCfgDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn app_config_load_missing_file_gives_defaults() {
    let t = TempCfgDir::new("missing");
    let cfg = AppConfig::load(&t.dir.join(".specseal.yaml")).expect("missing file → defaults");
    assert!(cfg.spec_dir.is_none());
    assert!(cfg.remote.is_none());
    assert!(cfg.tools.is_empty());
}

#[test]
fn app_config_load_empty_or_comment_only_file_gives_defaults() {
    // A template-fresh or commented-out file is a NULL document — that is valid
    // YAML, not a parse failure. Fail-closed must not break it.
    for content in ["", "\n\n", "# Specseal application config\n# tools:\n"] {
        let t = TempCfgDir::new("empty");
        let cfg = AppConfig::load(&t.app_yaml(content))
            .unwrap_or_else(|e| panic!("{content:?} must give defaults, got: {e}"));
        assert!(cfg.remote.is_none(), "for {content:?}");
    }
}

#[test]
fn app_config_load_bad_yaml_is_a_config_error() {
    // P0 fail-closed: a file that EXISTS but cannot parse is an error carrying
    // the workspace-relative path and the parser's reason — never defaults.
    for bad in ["remote: [unclosed", ": not yaml : [", "remote: 42", "tools: notalist"] {
        let t = TempCfgDir::new("bad");
        let err = AppConfig::load(&t.app_yaml(bad))
            .expect_err(&format!("{bad:?} must be a config error"));
        assert_eq!(err.file, ".specseal.yaml", "for {bad:?}");
        assert!(!err.reason.is_empty(), "reason must not be empty for {bad:?}");
        let msg = err.to_string();
        assert!(msg.contains(".specseal.yaml"), "display names the file: {msg}");
        assert!(msg.contains(&err.reason), "display carries the reason: {msg}");
    }
}

#[test]
fn app_config_load_valid_file_behavior_unchanged() {
    // Successfully parsing files keep their exact behavior (unknown keys tolerated).
    let t = TempCfgDir::new("valid");
    let path = t.app_yaml("spec_dir: docs/specs\nfuture_key: ignored\ntools:\n  - claude\n");
    let cfg = AppConfig::load(&path).expect("valid file parses");
    assert_eq!(cfg.spec_dir.as_deref(), Some("docs/specs"));
    assert_eq!(cfg.tools.len(), 1);
}

#[test]
fn workflow_config_from_text_missing_gives_defaults() {
    let w = WorkflowConfig::from_text(None).expect("missing document → defaults");
    assert_eq!(w.schema, None);
    assert_eq!(w.tdd, None);
}

#[test]
fn workflow_config_from_text_empty_or_comment_only_gives_defaults() {
    for text in ["", "\n", "# workflow config\n# tdd: true\n"] {
        let w = WorkflowConfig::from_text(Some(text))
            .unwrap_or_else(|e| panic!("{text:?} must give defaults, got: {e}"));
        assert_eq!(w.tdd, None, "for {text:?}");
    }
}

#[test]
fn workflow_config_from_text_bad_yaml_is_a_config_error() {
    for bad in ["rules: [unclosed", "tdd: [true]", ": not yaml : ["] {
        let err = WorkflowConfig::from_text(Some(bad))
            .expect_err(&format!("{bad:?} must be a config error"));
        assert_eq!(err.file, "specseal/config.yaml", "for {bad:?}");
        assert!(!err.reason.is_empty(), "reason must not be empty for {bad:?}");
        let msg = err.to_string();
        assert!(msg.contains("specseal/config.yaml"), "display names the file: {msg}");
    }
}

// --- tools: dual-form entries (builtin name string | descriptor object) ---

#[test]
fn tools_list_parses_builtin_strings_and_descriptors() {
    let a = app(
        "tools:\n  - claude\n  - name: wad-harness\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\n    invocation: tool-call\n",
    );
    assert_eq!(a.tools.len(), 2);
    match &a.tools[0] {
        ToolEntry::Builtin(s) => assert_eq!(s, "claude"),
        other => panic!("expected builtin string entry, got {other:?}"),
    }
    match &a.tools[1] {
        ToolEntry::Descriptor(d) => {
            assert_eq!(d.name.as_deref(), Some("wad-harness"));
            assert_eq!(d.skills_dir.as_deref(), Some(".wad/skills"));
            assert_eq!(d.instructions_file.as_deref(), Some("WAD.md"));
            assert_eq!(d.invocation.as_deref(), Some("tool-call"));
        }
        other => panic!("expected descriptor entry, got {other:?}"),
    }
}

#[test]
fn tools_list_of_plain_strings_still_parses() {
    let a = app("tools:\n  - claude\n  - codex\n");
    assert_eq!(a.tools.len(), 2);
    assert!(matches!(&a.tools[0], ToolEntry::Builtin(s) if s == "claude"));
    assert!(matches!(&a.tools[1], ToolEntry::Builtin(s) if s == "codex"));
}

// --- descriptor validation: single-line semantic errors naming the field ---

fn descriptor(name: &str, skills_dir: &str, instructions_file: &str) -> ToolDescriptor {
    ToolDescriptor {
        name: Some(name.to_string()),
        skills_dir: Some(skills_dir.to_string()),
        instructions_file: Some(instructions_file.to_string()),
        invocation: None,
    }
}

#[test]
fn descriptor_validation_accepts_valid_input_and_defaults_invocation_to_cli() {
    let v = descriptor("wad-harness", ".wad/skills", "WAD.md")
        .validate()
        .expect("valid descriptor");
    assert_eq!(v.name, "wad-harness");
    assert_eq!(v.invocation, Invocation::Cli);
    let mut d = descriptor("wad-harness", ".wad/skills", "WAD.md");
    d.invocation = Some("tool-call".to_string());
    assert_eq!(d.validate().unwrap().invocation, Invocation::ToolCall);
}

#[test]
fn descriptor_validation_rejects_builtin_name_conflict() {
    let err = descriptor("claude", ".wad/skills", "WAD.md").validate().unwrap_err();
    assert!(err.contains("name"), "must name the field: {err}");
    assert!(!err.contains('\n'), "single line: {err:?}");
}

#[test]
fn descriptor_validation_reserves_the_copilot_name() {
    // Scenario「名为 copilot 或指向 Copilot 目录的既有描述子升级后被拒」的名称分支：
    // copilot 成了内置工具，消息须列出三个内置名。
    let err = descriptor("copilot", ".copilot-skills", "WAD.md")
        .validate()
        .unwrap_err();
    assert!(err.contains("name"), "must name the field: {err}");
    for builtin in ["claude", "codex", "copilot"] {
        assert!(err.contains(builtin), "must list {builtin}: {err}");
    }
    assert!(!err.contains('\n'), "single line: {err:?}");
}

#[test]
fn descriptor_validation_rejects_the_copilot_skills_dir() {
    // Example 表的 .github/skills 列与其等价拼法：比对走路径范式。
    for bad in [
        ".github/skills",
        "./.github/skills",
        ".github/skills/.",
        ".github//skills",
        ".wad/../.github/skills",
    ] {
        let err = descriptor("my-copilot", bad, "WAD.md")
            .validate()
            .unwrap_err();
        assert!(
            err.contains("skills_dir"),
            "must name the field for {bad:?}: {err}"
        );
        assert!(
            err.contains("copilot"),
            "must name the built-in it belongs to for {bad:?}: {err}"
        );
        assert!(!err.contains('\n'), "single line: {err:?}");
    }
}

#[test]
fn descriptor_validation_rejects_built_in_skills_dirs_in_any_case() {
    // macOS／Windows 的文件系统不分大小写：换大小写的拼法仍是同一个目录。
    for (bad, builtin) in [
        (".GitHub/skills", "copilot"),
        (".github/Skills", "copilot"),
        (".Claude/skills", "claude"),
        (".AGENTS/SKILLS", "codex"),
    ] {
        let err = descriptor("wad-harness", bad, "WAD.md")
            .validate()
            .unwrap_err();
        assert!(
            err.contains(builtin),
            "must name the built-in it belongs to for {bad:?}: {err}"
        );
    }
}

#[test]
fn descriptor_validation_accepts_a_directory_next_to_the_copilot_one() {
    for ok in [".github/skills-extra", ".github/agents"] {
        let v = descriptor("wad-harness", ok, "WAD.md").validate();
        assert!(v.is_ok(), "{ok} 应被接受：{v:?}");
    }
}

#[test]
fn descriptor_validation_reserves_the_pi_and_cursor_names() {
    // Scenario「名为 pi、cursor 或指向其目录的既有描述子升级后被拒」的名称分支：
    // 消息列出五个内置名。
    for (name, skills_dir) in [("pi", ".pi-skills"), ("cursor", ".my-cursor/skills")] {
        let err = descriptor(name, skills_dir, "WAD.md").validate().unwrap_err();
        assert!(err.contains(&format!("name '{name}'")), "must name the field: {err}");
        assert!(
            err.contains("(claude, codex, copilot, pi, cursor)"),
            "must list the five built-ins: {err}"
        );
        assert!(!err.contains('\n'), "single line: {err:?}");
    }
}

#[test]
fn descriptor_validation_follows_the_pi_and_cursor_rows_of_the_skills_dir_table() {
    // Example「skills_dir 的验证结果」的 pi、cursor 列：等价拼法与大小写同样被拒，
    // 旁边的目录照常接受。
    for (bad, builtin) in [
        (".pi/skills", "pi"),
        (".wad/../.pi/skills", "pi"),
        (".cursor/skills", "cursor"),
        (".cursor//skills", "cursor"),
        (".Cursor/skills", "cursor"),
    ] {
        let err = descriptor("wad-harness", bad, "WAD.md").validate().unwrap_err();
        assert!(err.contains("skills_dir"), "must name the field for {bad:?}: {err}");
        assert!(
            err.contains(&format!("is the built-in {builtin} skills directory")),
            "must name the built-in it belongs to for {bad:?}: {err}"
        );
        assert!(!err.contains('\n'), "single line: {err:?}");
    }
    for ok in [".pi/agent", ".cursor/rules"] {
        let v = descriptor("wad-harness", ok, "WAD.md").validate();
        assert!(v.is_ok(), "{ok} 应被接受：{v:?}");
    }
}

#[test]
fn descriptor_validation_rejects_non_kebab_case_names() {
    for bad in ["Wad-Harness", "wad_harness", "-wad", "wad-", "w", &"x".repeat(51)] {
        let err = descriptor(bad, ".wad/skills", "WAD.md").validate().unwrap_err();
        assert!(err.contains("name"), "must name the field for {bad:?}: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
    }
}

#[test]
fn descriptor_validation_rejects_paths_escaping_project_root() {
    let err = descriptor("wad-harness", "../outside/skills", "WAD.md").validate().unwrap_err();
    assert!(err.contains("skills_dir"), "must name the field: {err}");
    assert!(!err.contains('\n'), "single line: {err:?}");
    let err = descriptor("wad-harness", ".wad/skills", "../WAD.md").validate().unwrap_err();
    assert!(err.contains("instructions_file"), "must name the field: {err}");
    // Lexical dot-dot tricks and absolute paths are escapes too.
    assert!(descriptor("wad-harness", ".wad/../../x", "WAD.md").validate().is_err());
    assert!(descriptor("wad-harness", "/abs/skills", "WAD.md").validate().is_err());
    // A drive-letter path is absolute only on Windows; on unix the same string is a
    // legal (if odd) relative dir name — the containment check is lexical host-platform
    // semantics, so the rejection can only be asserted where it actually applies.
    if cfg!(windows) {
        assert!(descriptor("wad-harness", "C:\\abs\\skills", "WAD.md").validate().is_err());
    }
}

#[test]
fn descriptor_validation_normalizes_a_trailing_slash() {
    // skills_dir 是用户手写的字符串：结尾分隔符在边界一次削掉，下游（生成、
    // 足迹记录、过期探测的路径回报）就只看得到同一种形式。
    let v = descriptor("wad-harness", ".wad/skills/", "WAD.md").validate().unwrap();
    assert_eq!(v.skills_dir, ".wad/skills");
    let v = descriptor("wad-harness", ".wad/skills///", "WAD.md").validate().unwrap();
    assert_eq!(v.skills_dir, ".wad/skills", "连续分隔符一并削去");
}

#[test]
fn descriptor_validation_rejects_a_skills_dir_that_normalizes_to_nothing() {
    // 只由分隔符构成的 skills_dir 削完就是项目根本身——生成物会散进项目根、
    // 清理会扫到根目录；在边界挡掉，下游不必再验一次。
    for bad in ["/", "///", "./", ".", ".wad/.."] {
        let err = descriptor("wad-harness", bad, "WAD.md").validate().unwrap_err();
        assert!(err.contains("skills_dir"), "must name the field for {bad:?}: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
    }
}

#[test]
fn descriptor_validation_accepts_a_directory_next_to_a_builtin_one() {
    // Example 表的接受列：只有范式后「等同」内置目录才拒绝，相邻的名字不受影响。
    for ok in [".claude/skills-extra", ".claudex/skills", ".agents/skills2"] {
        let v = descriptor("wad-harness", ok, "WAD.md").validate();
        assert!(v.is_ok(), "{ok} 应被接受：{v:?}");
    }
}

#[test]
fn descriptor_validation_rejects_a_builtin_skills_dir() {
    // 描述子指到内置工具的 skills 目录：两个 target 会对同一份 SKILL.md 各比一次
    // 期望内容（探测永远回报过期），且生成时后手的 非 Claude 子集会把前手刚写的
    // claude 专属技能当成孤儿删掉。名称冲突已挡，目录冲突同理。
    // 等价拼法与字面拼法一样被挡：比对走路径范式，不是字符串相等。
    for bad in [
        ".claude/skills",
        ".agents/skills",
        ".claude/skills/",
        ".claude//skills",
        ".claude/skills/.",
        "./.claude/skills",
        ".claude/./skills",
        ".wad/../.claude/skills",
    ] {
        let err = descriptor("wad-harness", bad, "WAD.md").validate().unwrap_err();
        assert!(err.contains("skills_dir"), "must name the field for {bad:?}: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
    }
}

#[test]
fn descriptor_validation_rejects_unknown_invocation() {
    let mut d = descriptor("wad-harness", ".wad/skills", "WAD.md");
    d.invocation = Some("http".to_string());
    let err = d.validate().unwrap_err();
    assert!(err.contains("invocation"), "must name the field: {err}");
    assert!(!err.contains('\n'), "single line: {err:?}");
}

#[test]
fn descriptor_validation_rejects_missing_required_fields() {
    let d = ToolDescriptor {
        name: Some("wad-harness".to_string()),
        skills_dir: None,
        instructions_file: Some("WAD.md".to_string()),
        invocation: None,
    };
    let err = d.validate().unwrap_err();
    assert!(err.contains("skills_dir"), "must name the missing field: {err}");
}

// --- remote section: optional connection settings (url / repo) ---

#[test]
fn remote_section_with_url_and_repo_parses_both_fields() {
    let a = app("remote:\n  url: https://team.example.com/specseal/projects/foo\n  repo: backend\n");
    let r = a.remote.as_ref().expect("remote section present");
    assert_eq!(
        r.url.as_deref(),
        Some("https://team.example.com/specseal/projects/foo")
    );
    assert_eq!(r.repo.as_deref(), Some("backend"));
}

#[test]
fn remote_section_with_only_repo_leaves_url_absent() {
    // Committed files may omit url (supplied at runtime via SPECSEAL_STORE_URL).
    let a = app("remote:\n  repo: backend\n");
    let r = a.remote.as_ref().expect("remote section present");
    assert_eq!(r.url, None);
    assert_eq!(r.repo.as_deref(), Some("backend"));
}

#[test]
fn empty_remote_section_is_present_with_absent_fields() {
    // Both `remote: {}` and a bare `remote:` key mean "section present, fields
    // empty" — a bare key must not silently read as fs mode (the mode signal is
    // key presence, and missing url must fail loudly downstream, not vanish here).
    for yaml in ["remote: {}\n", "remote:\n"] {
        let a = app(yaml);
        let r = a
            .remote
            .as_ref()
            .unwrap_or_else(|| panic!("remote section present for {yaml:?}"));
        assert_eq!(r.url, None);
        assert_eq!(r.repo, None);
    }
}

#[test]
fn config_without_remote_key_parses_with_section_absent() {
    // Backward compatibility: existing .specseal.yaml files without a remote key
    // keep parsing, other fields intact, and the section reads as absent.
    let a = app("tools:\n  - claude\n  - codex\n");
    assert!(a.remote.is_none());
    assert_eq!(a.tools.len(), 2);
}

// --- existing two-layer resolvers keep their observable behavior ---

#[test]
fn resolve_locale_reads_the_canonical_config_only() {
    assert_eq!(resolve_locale(&wf("locale: ja")), "Japanese (日本语)");
    assert_eq!(resolve_locale(&wf("{}")), "English");
}

#[test]
fn resolve_spec_locale_keeps_auto_and_english_normalization() {
    assert_eq!(
        resolve_spec_locale(&wf("spec_locale: auto\nlocale: tw")).as_deref(),
        Some("tw")
    );
    assert_eq!(resolve_spec_locale(&wf("spec_locale: en")), None);
    assert_eq!(resolve_spec_locale(&wf("{}")), None);
}

// --- update_workflow_config_text: settings-page rewrite (text→text) ---

const WF_DOC: &str = "schema: spec-driven\n\nlocale: tw\ncontext: |\n  line one\n  line two\n\nrules:\n  proposal:\n    - first rule\n    - second rule\n";

#[test]
fn workflow_update_sets_all_policy_fields_and_output_parses() {
    let fields = WorkflowPolicyFields {
        locale: Some("ja".into()),
        spec_locale: Some("auto".into()),
        tdd: true,
        audit: true,
        worktree: true,
    };
    let out = update_workflow_config_text(WF_DOC, &fields, &ContentEdit::default()).expect("rewrite ok");
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(w.locale.as_deref(), Some("ja"));
    assert_eq!(w.spec_locale.as_deref(), Some("auto"));
    assert_eq!(w.tdd, Some(true));
    assert_eq!(w.audit, Some(true));
    assert_eq!(w.worktree, Some(true));
}

#[test]
fn workflow_update_preserves_untouched_key_values_verbatim() {
    // Re-serialization may change YAML styling; the parsed VALUES of every
    // untouched key (schema, multi-line context, rules) must stay identical
    // character for character.
    let fields = WorkflowPolicyFields { tdd: true, ..Default::default() };
    let out = update_workflow_config_text(WF_DOC, &fields, &ContentEdit::default()).expect("rewrite ok");
    let (orig, new) = (wf(WF_DOC), wf(&out));
    assert_eq!(new.schema, orig.schema);
    assert_eq!(new.context, orig.context);
    assert_eq!(new.rules, orig.rules);
}

#[test]
fn workflow_update_keeps_unknown_keys() {
    let doc = "schema: spec-driven\nfuture_key: keep me\n";
    let out = update_workflow_config_text(doc, &WorkflowPolicyFields::default(), &ContentEdit::default()).expect("rewrite ok");
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    assert_eq!(m.get("future_key").and_then(|v| v.as_str()), Some("keep me"));
}

#[test]
fn workflow_update_default_values_remove_keys() {
    let doc = "locale: tw\nspec_locale: auto\ntdd: true\naudit: true\nschema: spec-driven\n";
    let out = update_workflow_config_text(doc, &WorkflowPolicyFields::default(), &ContentEdit::default()).expect("rewrite ok");
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    for key in ["locale", "spec_locale", "tdd", "audit"] {
        assert!(!m.contains_key(key), "key '{key}' must be removed, got: {out}");
    }
    assert!(m.contains_key("schema"));
}

#[test]
fn workflow_update_writes_and_removes_worktree() {
    // Spec scenario worktree 字段写入与呈现: `set worktree true` lands `worktree: true`.
    let fields = WorkflowPolicyFields { worktree: true, ..Default::default() };
    let out = update_workflow_config_text("schema: spec-driven\n", &fields, &ContentEdit::default())
        .expect("rewrite ok");
    assert_eq!(
        WorkflowConfig::from_text(Some(&out)).expect("output parses").worktree,
        Some(true),
        "got: {out}"
    );
    // Back to default removes the key, like the other toggles.
    let out = update_workflow_config_text(&out, &WorkflowPolicyFields::default(), &ContentEdit::default())
        .expect("rewrite ok");
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    assert!(!m.contains_key("worktree"), "worktree must be removed, got: {out}");
    assert!(m.contains_key("schema"));
}

#[test]
fn workflow_update_bad_yaml_is_a_loud_error() {
    // Unlike WorkflowConfig::from_text (silent defaults), rewriting a malformed
    // document must fail loudly — otherwise the GUI would destroy user content.
    for bad in ["rules: [unclosed", "just a top-level scalar"] {
        assert!(
            update_workflow_config_text(bad, &WorkflowPolicyFields::default(), &ContentEdit::default()).is_err(),
            "must reject {bad:?}"
        );
    }
}

#[test]
fn workflow_update_empty_input_creates_fresh_document() {
    // Absent config.yaml: the caller hands an empty text and gets a fresh
    // parseable document containing exactly the requested fields.
    let fields = WorkflowPolicyFields { locale: Some("tw".into()), ..Default::default() };
    let out = update_workflow_config_text("", &fields, &ContentEdit::default()).expect("rewrite ok");
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(w.locale.as_deref(), Some("tw"));
}

#[test]
fn workflow_update_matches_spec_example_table() {
    // spec「政策字段写入效果」Example 表——逐行对应。
    // 无 tdd 键 | tdd 切打开 | 添加 tdd: true
    let fields = WorkflowPolicyFields { tdd: true, ..Default::default() };
    let out = update_workflow_config_text("schema: spec-driven\n", &fields, &ContentEdit::default()).unwrap();
    assert_eq!(WorkflowConfig::from_text(Some(&out)).expect("output parses").tdd, Some(true));
    // tdd: true | tdd 切关闭 | tdd 键被移除（缺省即 false）——唯一键移除后输出为空文档
    let out = update_workflow_config_text("tdd: true\n", &WorkflowPolicyFields::default(), &ContentEdit::default()).unwrap();
    assert_eq!(WorkflowConfig::from_text(Some(&out)).expect("output parses").tdd, None, "got: {out}");
    // locale: tw、含 rules | spec_locale 选 auto | 添加 spec_locale: auto，locale 与 rules 原样保留
    let doc = "locale: tw\nrules:\n  proposal:\n    - keep\n";
    let fields = WorkflowPolicyFields {
        locale: Some("tw".into()),
        spec_locale: Some("auto".into()),
        ..Default::default()
    };
    let out = update_workflow_config_text(doc, &fields, &ContentEdit::default()).unwrap();
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(w.spec_locale.as_deref(), Some("auto"));
    assert_eq!(w.locale.as_deref(), Some("tw"));
    assert_eq!(w.rules, wf(doc).rules);
}

// --- policy locale 值域验证（workflow-config-locale-validation，design D1／D3）---

#[test]
fn validate_policy_locales_accepts_codes_and_unset() {
    for code in ["tw", "ja", "en"] {
        let f = WorkflowPolicyFields { locale: Some(code.into()), ..Default::default() };
        assert!(validate_policy_locales(&f).is_ok(), "locale {code} must pass");
        let f = WorkflowPolicyFields { spec_locale: Some(code.into()), ..Default::default() };
        assert!(validate_policy_locales(&f).is_ok(), "spec_locale {code} must pass");
    }
    // spec_locale 另接受 auto；locale 不接受 auto
    let f = WorkflowPolicyFields { spec_locale: Some("auto".into()), ..Default::default() };
    assert!(validate_policy_locales(&f).is_ok());
    let f = WorkflowPolicyFields { locale: Some("auto".into()), ..Default::default() };
    assert!(validate_policy_locales(&f).is_err(), "locale auto must be rejected");
    // None（未设置）恒合法
    assert!(validate_policy_locales(&WorkflowPolicyFields::default()).is_ok());
}

#[test]
fn validate_policy_locales_rejects_display_names_and_case_variants() {
    // spec「locale 值域判定」Example 表的拒绝列
    for bad in ["繁体中文", "TW", "Auto", ""] {
        let f = WorkflowPolicyFields { locale: Some(bad.into()), ..Default::default() };
        assert!(validate_policy_locales(&f).is_err(), "locale {bad:?} must be rejected");
    }
    for bad in ["繁体中文", "zh-Hant", "AUTO"] {
        let f = WorkflowPolicyFields { spec_locale: Some(bad.into()), ..Default::default() };
        assert!(validate_policy_locales(&f).is_err(), "spec_locale {bad:?} must be rejected");
    }
}

#[test]
fn validate_policy_locales_error_names_field_value_and_codes() {
    let f = WorkflowPolicyFields { locale: Some("繁体中文".into()), ..Default::default() };
    let err = validate_policy_locales(&f).unwrap_err().to_string();
    for needle in ["locale", "繁体中文", "tw", "ja", "en"] {
        assert!(err.contains(needle), "error must contain {needle:?}, got: {err}");
    }
    let f = WorkflowPolicyFields { spec_locale: Some("zh-Hant".into()), ..Default::default() };
    let err = validate_policy_locales(&f).unwrap_err().to_string();
    for needle in ["spec_locale", "zh-Hant", "auto"] {
        assert!(err.contains(needle), "error must contain {needle:?}, got: {err}");
    }
}

#[test]
fn workflow_update_rejects_invalid_locale_fields_without_output() {
    let fields = WorkflowPolicyFields { locale: Some("繁体中文".into()), ..Default::default() };
    let err = update_workflow_config_text("schema: spec-driven\n", &fields, &ContentEdit::default())
        .unwrap_err()
        .to_string();
    assert!(err.contains("locale") && err.contains("繁体中文"), "got: {err}");
    let fields = WorkflowPolicyFields { spec_locale: Some("zh-Hant".into()), ..Default::default() };
    assert!(
        update_workflow_config_text("schema: spec-driven\n", &fields, &ContentEdit::default()).is_err()
    );
}

#[test]
fn workflow_update_injected_special_values_are_rejected() {
    // Sharp-edges audit（Scoundrel）：locale 含换行或 YAML 语法的注入矢量，
    // 自值域验证上线后在串行化前即被拒绝——文档结构不可能被破坏。
    // （原测试断言 escape 后 round-trip；值域验证使拒绝成为更强的防护。）
    for evil in ["tw\nrules: {}", "a: b", "#comment", "'quoted'", "- item"] {
        let fields = WorkflowPolicyFields { locale: Some(evil.into()), ..Default::default() };
        assert!(
            update_workflow_config_text("schema: spec-driven\n", &fields, &ContentEdit::default()).is_err(),
            "injection vector must be rejected: {evil:?}"
        );
    }
}

// --- update_workflow_config_text: context 三态与 rules 整份代换（desktop-config-rules-context） ---

/// 政策字段与 context/rules 皆不动的调用缩写（多数测试只关心其中一个变更集）。
fn rewrite(
    doc: &str,
    context: &ContextEdit,
    rules: Option<&[(String, Vec<String>)]>,
) -> anyhow::Result<String> {
    update_workflow_config_text(doc, &wf_fields_of(doc), &ContentEdit { context: context.clone(), rules, ..Default::default() })
}

/// 从原文读出政策字段现值（「完整目标状态」契约：不想动政策就得先读再回填）。
fn wf_fields_of(doc: &str) -> WorkflowPolicyFields {
    let w = wf(doc);
    WorkflowPolicyFields {
        locale: w.locale.clone(),
        spec_locale: w.spec_locale.clone(),
        tdd: w.tdd.unwrap_or(false),
        audit: w.audit.unwrap_or(false),
        worktree: w.worktree.unwrap_or(false),
    }
}

fn section(pairs: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect()))
        .collect()
}

#[test]
fn workflow_update_context_set_round_trips_value_verbatim() {
    // spec Scenario 编辑项目说明并保存：值逐字符一致、其余键原样保留。
    let text = "第一行说明\n\n第二行：含冒号: 与 # 井号\n";
    let out = rewrite(WF_DOC, &ContextEdit::Set(text.into()), None).expect("rewrite ok");
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(w.context.as_deref(), Some(text));
    assert_eq!(w.schema, wf(WF_DOC).schema);
    assert_eq!(w.rules, wf(WF_DOC).rules);
    assert_eq!(w.locale, wf(WF_DOC).locale);
}

#[test]
fn workflow_update_context_keeps_nested_indent_and_trailing_newline_verbatim() {
    // spec Scenario 编辑项目说明并保存：两层缩进的清单与档尾换行逐字符保留（有无档尾换行皆然）。
    for text in [
        "# 规范\n\n- 第一层\n  - 第二层\n    - 第三层\n",
        "# 规范\n\n- 第一层\n  - 第二层\n    - 第三层",
    ] {
        let out = rewrite(WF_DOC, &ContextEdit::Set(text.into()), None).expect("rewrite ok");
        assert_eq!(
            wf(&out).context.as_deref(),
            Some(text),
            "round trip of {text:?}, got: {out}"
        );
    }
}

#[test]
fn workflow_update_context_three_states() {
    // 三态：Keep 不动、Set 设值、Remove 移除键。
    let out = rewrite(WF_DOC, &ContextEdit::Keep, None).expect("rewrite ok");
    assert_eq!(wf(&out).context, wf(WF_DOC).context, "Keep must not touch context");
    let out = rewrite(WF_DOC, &ContextEdit::Remove, None).expect("rewrite ok");
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    assert!(!m.contains_key("context"), "Remove must delete the key, got: {out}");
    let out = rewrite("schema: spec-driven\n", &ContextEdit::Set("新说明".into()), None).unwrap();
    assert_eq!(wf(&out).context.as_deref(), Some("新说明"));
}

#[test]
fn workflow_update_context_blank_set_removes_key() {
    // 清空即移除键的语意在 core 落实：Set 空白字符串视同 Remove（zero-value 安全）。
    for blank in ["", "   ", "\n\n"] {
        let out = rewrite(WF_DOC, &ContextEdit::Set(blank.into()), None).expect("rewrite ok");
        let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
        assert!(!m.contains_key("context"), "blank {blank:?} must remove the key");
    }
}

#[test]
fn workflow_update_rules_replace_preserves_entry_order() {
    // spec Example 条目对调：tasks 节「先写失败测试」「更新文档」→ 上移后顺序对调。
    let doc = "schema: spec-driven\nrules:\n  tasks:\n    - 先写失败测试\n    - 更新文档\n";
    let rules = section(&[("tasks", &["更新文档", "先写失败测试"])]);
    let out = rewrite(doc, &ContextEdit::Keep, Some(&rules)).expect("rewrite ok");
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(
        w.rules.get("tasks").map(Vec::as_slice),
        Some(["更新文档".to_string(), "先写失败测试".to_string()].as_slice())
    );
    assert_eq!(w.schema.as_deref(), Some("spec-driven"));
}

#[test]
fn workflow_update_rules_key_removal_matches_spec_example_table() {
    // spec Example 键移除语意——逐行对应。
    // context: 旧说明、rules 含 tasks 两条 | 清空项目说明 | context 移除，rules.tasks 原样保留
    let doc = "context: 旧说明\nrules:\n  tasks:\n    - a\n    - b\n";
    let out = rewrite(doc, &ContextEdit::Remove, None).expect("rewrite ok");
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    assert!(!m.contains_key("context"));
    assert_eq!(wf(&out).rules, wf(doc).rules);
    // rules 含 proposal 与 tasks 两节 | 删除 tasks 节全部条目 | rules 仅余 proposal 节
    let doc = "rules:\n  proposal:\n    - p1\n  tasks:\n    - t1\n";
    let rules = section(&[("proposal", &["p1"]), ("tasks", &[])]);
    let out = rewrite(doc, &ContextEdit::Keep, Some(&rules)).expect("rewrite ok");
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(w.rules.get("proposal").map(Vec::as_slice), Some(["p1".to_string()].as_slice()));
    assert!(!w.rules.contains_key("tasks"), "empty section must drop its key");
    // rules 仅含 tasks 一节 | 删除该节全部条目 | rules 键整个被移除
    let doc = "schema: spec-driven\nrules:\n  tasks:\n    - t1\n";
    let rules = section(&[("tasks", &[])]);
    let out = rewrite(doc, &ContextEdit::Keep, Some(&rules)).expect("rewrite ok");
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    assert!(!m.contains_key("rules"), "all-empty rules must remove the key, got: {out}");
    assert!(m.contains_key("schema"));
}

#[test]
fn workflow_update_rules_entries_trimmed_and_blank_dropped() {
    // 条目存入前 trim、空字符串条目涤除；涤除后空节一并移除。
    let rules = section(&[("tasks", &["  先写失败测试  ", "   ", ""]), ("design", &["  ", ""])]);
    let out = rewrite("{}", &ContextEdit::Keep, Some(&rules)).expect("rewrite ok");
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(
        w.rules.get("tasks").map(Vec::as_slice),
        Some(["先写失败测试".to_string()].as_slice())
    );
    assert!(!w.rules.contains_key("design"), "all-blank section must drop its key");
}

#[test]
fn workflow_update_rules_reserved_char_entries_round_trip() {
    // spec Example 保留字符条目自动加引号：GIVEN proposal 节一条，WHEN tasks 节添加
    // 「@完成后运行全部测试」，THEN 可解析、值逐字符还原、proposal 与 schema 保留。
    let doc = "schema: spec-driven\nrules:\n  proposal:\n    - 提案必须列出影响的 crates\n";
    let rules = section(&[
        ("proposal", &["提案必须列出影响的 crates"]),
        ("tasks", &["@完成后运行全部测试"]),
    ]);
    let out = rewrite(doc, &ContextEdit::Keep, Some(&rules)).expect("rewrite ok");
    let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
    assert_eq!(
        w.rules.get("tasks").map(Vec::as_slice),
        Some(["@完成后运行全部测试".to_string()].as_slice())
    );
    assert_eq!(
        w.rules.get("proposal").map(Vec::as_slice),
        Some(["提案必须列出影响的 crates".to_string()].as_slice())
    );
    assert_eq!(w.schema.as_deref(), Some("spec-driven"));
    // 反引号开头（既知炸档地雷）与其他 YAML 保留起始字符亦须 round-trip。
    for evil in ["`cargo test` 全绿", "@标注开头", "*星号开头", "&锚点开头"] {
        let rules = section(&[("tasks", &[evil])]);
        let out = rewrite("{}", &ContextEdit::Keep, Some(&rules)).expect("rewrite ok");
        let w = WorkflowConfig::from_text(Some(&out)).expect("output parses");
        assert_eq!(
            w.rules.get("tasks").map(Vec::as_slice),
            Some([evil.to_string()].as_slice()),
            "round-trip for {evil:?}"
        );
        assert!(!w.rules.is_empty(), "document must stay parseable for {evil:?}");
    }
}

#[test]
fn workflow_update_rules_none_leaves_rules_untouched() {
    // rules: None＝不动——政策字段写入路径不得波及 rules。
    let out = rewrite(WF_DOC, &ContextEdit::Keep, None).expect("rewrite ok");
    assert_eq!(wf(&out).rules, wf(WF_DOC).rules);
}

#[test]
fn workflow_update_content_edit_preserves_reserved_keys_verbatim() {
    // MODIFIED 需求保留名单：remote、spec_dir、未知键于 context/rules 写入时逐值保留。
    let doc = "spec_dir: docs/specs\nremote:\n  url: https://example.com\n  repo: main\nfuture_key: keep me\ncontext: old\n";
    let rules = section(&[("tasks", &["新规则"])]);
    let out = rewrite(doc, &ContextEdit::Set("新说明".into()), Some(&rules)).expect("rewrite ok");
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    let orig: serde_yaml::Mapping = serde_yaml::from_str(doc).expect("mapping");
    for key in ["spec_dir", "remote", "future_key"] {
        assert_eq!(m.get(key), orig.get(key), "key '{key}' must carry over");
    }
    assert_eq!(wf(&out).context.as_deref(), Some("新说明"));
}

#[test]
fn workflow_update_content_edit_bad_yaml_is_a_loud_error() {
    // 不经 rewrite helper——坏 YAML 连现值都读不出，直接以 default 政策调用。
    for bad in ["rules: [unclosed", "just a top-level scalar"] {
        assert!(
            update_workflow_config_text(
                bad,
                &WorkflowPolicyFields::default(),
                &ContentEdit { context: ContextEdit::Set("x".into()), ..Default::default() },
            )
            .is_err(),
            "must reject {bad:?}"
        );
    }
}

// --- update_workflow_config_text: 文本层手术（workflow-config-surgical-write） ---

/// 只设置 locale、其余政策字段维持缺省的缩写。
fn loc(code: &str) -> WorkflowPolicyFields {
    WorkflowPolicyFields { locale: Some(code.into()), ..Default::default() }
}

#[test]
fn surgical_missing_key_inserts_below_schema_with_single_blank_lines() {
    // spec Scenario 缺键插于 schema 之下且空行区隔——相邻处已有空行时不重复补。
    let doc = "# 模板注解\nschema: spec-driven\n\ncontext: |\n  第一行\n\nrules:\n  proposal:\n    - 条目一\n";
    let out = update_workflow_config_text(doc, &loc("tw"), &ContentEdit::default()).expect("rewrite ok");
    assert_eq!(
        out,
        "# 模板注解\nschema: spec-driven\n\nlocale: tw\n\ncontext: |\n  第一行\n\nrules:\n  proposal:\n    - 条目一\n"
    );
    // 相邻处原本没有空行时补上：插入区块与前后内容各恰一空行。
    let out = update_workflow_config_text(
        "schema: spec-driven\ncontext: 说明\n",
        &loc("tw"),
        &ContentEdit::default(),
    )
    .expect("rewrite ok");
    assert_eq!(out, "schema: spec-driven\n\nlocale: tw\n\ncontext: 说明\n");
}

#[test]
fn surgical_multiple_missing_keys_insert_one_canonical_block() {
    // 多缺键一次写入：正典序（locale、spec_locale、tdd、audit、worktree）成连续区块，不分散。
    let fields = WorkflowPolicyFields {
        locale: Some("tw".into()),
        spec_locale: Some("auto".into()),
        tdd: true,
        audit: true,
        worktree: true,
    };
    let out = update_workflow_config_text(
        "schema: spec-driven\n\ncontext: 说明\n",
        &fields,
        &ContentEdit::default(),
    )
    .expect("rewrite ok");
    assert_eq!(
        out,
        "schema: spec-driven\n\nlocale: tw\nspec_locale: auto\ntdd: true\naudit: true\nworktree: true\n\ncontext: 说明\n"
    );
}

#[test]
fn surgical_preserves_comments_and_blank_lines_byte_for_byte() {
    // spec Scenario 注解与空行逐比特保留：原位改值只动目标行。
    let doc = "# 头注解\nschema: spec-driven\n\n# locale 注解\nlocale: tw\n\n# 尾注解\ncontext: 说明\n";
    let out = update_workflow_config_text(doc, &loc("ja"), &ContentEdit::default()).expect("rewrite ok");
    assert_eq!(
        out,
        "# 头注解\nschema: spec-driven\n\n# locale 注解\nlocale: ja\n\n# 尾注解\ncontext: 说明\n"
    );
}

#[test]
fn surgical_tail_key_updated_in_place_never_moves() {
    // spec Scenario 档尾既有键原位改值不搬家（曾被旧版附加在 rules 之后）。
    let doc = "schema: spec-driven\n\nrules:\n  tasks:\n    - a\n\nlocale: tw\n";
    let out = update_workflow_config_text(doc, &loc("ja"), &ContentEdit::default()).expect("rewrite ok");
    assert_eq!(out, "schema: spec-driven\n\nrules:\n  tasks:\n    - a\n\nlocale: ja\n");
}

#[test]
fn surgical_missing_schema_inserts_at_file_top() {
    // spec Scenario schema 缺席时插于文件最顶端，与后续内容之间恰一空行。
    let fields = WorkflowPolicyFields { tdd: true, ..Default::default() };
    let out = update_workflow_config_text("context: 说明\n", &fields, &ContentEdit::default())
        .expect("rewrite ok");
    assert_eq!(out, "tdd: true\n\ncontext: 说明\n");
    // 空文件：只有插入区块本身，无多余空行。
    let out = update_workflow_config_text("", &loc("tw"), &ContentEdit::default()).expect("rewrite ok");
    assert_eq!(out, "locale: tw\n");
}

#[test]
fn surgical_user_content_below_schema_shifts_down_verbatim() {
    // schema 底下用户自加内容：插入点仍在 schema 键行之后，用户内容原样后移。
    let doc = "schema: spec-driven\n# 用户自加说明\nmy_key: 自订\n\ncontext: 说明\n";
    let out = update_workflow_config_text(doc, &loc("tw"), &ContentEdit::default()).expect("rewrite ok");
    assert_eq!(
        out,
        "schema: spec-driven\n\nlocale: tw\n\n# 用户自加说明\nmy_key: 自订\n\ncontext: 说明\n"
    );
}

#[test]
fn surgical_set_false_removes_key_line_keeps_comment_above() {
    // spec Scenario 设 false 移除键：只删键行，上方注解行仍在。
    let doc = "schema: spec-driven\n\n# audit 开关\naudit: true\n\ncontext: 说明\n";
    let out = update_workflow_config_text(doc, &WorkflowPolicyFields::default(), &ContentEdit::default())
        .expect("rewrite ok");
    assert_eq!(out, "schema: spec-driven\n\n# audit 开关\n\ncontext: 说明\n");
}

#[test]
fn surgical_context_replaces_only_its_block() {
    // context 整块替换：仅 context 区块变动，前后注解与其他区段逐比特不变；
    // 旧值内含空行（block scalar 中段空行）仍属同一区块、不误切。
    let doc = "schema: spec-driven\n\n# 说明区\ncontext: |\n  旧一\n\n  旧二\n\n# 规则区\nrules:\n  tasks:\n    - a\n";
    let out = update_workflow_config_text(
        doc,
        &WorkflowPolicyFields::default(),
        &ContentEdit { context: ContextEdit::Set("新一\n新二\n".into()), ..Default::default() },
    )
    .expect("rewrite ok");
    assert_eq!(
        out,
        "schema: spec-driven\n\n# 说明区\ncontext: |\n  新一\n  新二\n\n# 规则区\nrules:\n  tasks:\n    - a\n"
    );
}

#[test]
fn surgical_multiline_unknown_key_is_not_misjudged() {
    // 未知顶层键含多行 block scalar：缩进内容行（即使含冒号）不被误判为顶层键。
    let doc = "notes: |\n  first: 看似键\n  second: 也是\nlocale: tw\n";
    let out = update_workflow_config_text(doc, &loc("ja"), &ContentEdit::default()).expect("rewrite ok");
    assert_eq!(out, "notes: |\n  first: 看似键\n  second: 也是\nlocale: ja\n");
}

#[test]
fn surgical_no_trailing_newline_and_crlf_edges() {
    // 结尾无换行：插入前先补行终止，插入区块照常。
    let out = update_workflow_config_text("schema: spec-driven", &loc("tw"), &ContentEdit::default())
        .expect("rewrite ok");
    assert_eq!(out, "schema: spec-driven\n\nlocale: tw\n");
    // 结尾无换行的末行原位改值：不凭空补结尾换行。
    let out = update_workflow_config_text("schema: spec-driven\nlocale: tw", &loc("ja"), &ContentEdit::default())
        .expect("rewrite ok");
    assert_eq!(out, "schema: spec-driven\nlocale: ja");
    // CRLF 档：未动行逐比特保留，改写行与插入行沿用文件的 CRLF。
    let fields = WorkflowPolicyFields { locale: Some("ja".into()), tdd: true, ..Default::default() };
    let out = update_workflow_config_text(
        "schema: spec-driven\r\nlocale: tw\r\n",
        &fields,
        &ContentEdit::default(),
    )
    .expect("rewrite ok");
    assert_eq!(out, "schema: spec-driven\r\n\r\ntdd: true\r\n\r\nlocale: ja\r\n");
}

#[test]
fn surgical_rewrite_verification_failure_is_fail_closed() {
    // spec Scenario 内部改写验证失败拒绝写入：引号键 'locale' 对文本层手术不可见，
    // 插入裸键后重新解析成重复键——验证必须拦下并以单行错误拒写（函数为纯 text→text，
    // 调用端收到 Err 即不落档，原档逐比特不变）。
    let err = update_workflow_config_text("'locale': tw\n", &loc("ja"), &ContentEdit::default())
        .expect_err("must fail closed")
        .to_string();
    assert!(err.contains("internal rewrite verification failed"), "got: {err}");
    assert!(!err.contains('\n'), "error must be single-line, got: {err}");
    // 另一分支：输出可解析但与目标状态不等值——同样单行拒绝。
    let target: serde_yaml::Mapping = serde_yaml::from_str("locale: tw\n").expect("mapping");
    let err = verify_rewritten_config("locale: ja\n", &target)
        .expect_err("mismatch must fail closed")
        .to_string();
    assert!(err.contains("internal rewrite verification failed"), "got: {err}");
    assert!(!err.contains('\n'), "error must be single-line, got: {err}");
}

// --- update_app_config_tools_text: builtin tool selection rewrite ---

use crate::skills::Tool;

#[test]
fn tools_update_replaces_builtin_selection() {
    let out = update_app_config_tools_text("tools:\n  - claude\n", &[Tool::Claude, Tool::Codex])
        .expect("rewrite ok");
    let a = app(&out);
    assert_eq!(a.tools.len(), 2);
    assert!(matches!(&a.tools[0], ToolEntry::Builtin(s) if s == "claude"));
    assert!(matches!(&a.tools[1], ToolEntry::Builtin(s) if s == "codex"));
}

#[test]
fn tools_update_removes_deselected_builtins() {
    let out = update_app_config_tools_text("tools:\n  - claude\n  - codex\n", &[Tool::Claude])
        .expect("rewrite ok");
    let a = app(&out);
    assert_eq!(a.tools.len(), 1);
    assert!(matches!(&a.tools[0], ToolEntry::Builtin(s) if s == "claude"));
}

#[test]
fn tools_update_preserves_descriptors_and_other_keys() {
    let doc = concat!(
        "spec_dir: docs/specs\n",
        "tools:\n",
        "  - claude\n",
        "  - name: wad-harness\n",
        "    skills_dir: .wad/skills\n",
        "    instructions_file: WAD.md\n",
        "    future_field: keep me\n",
        "remote:\n",
        "  url: https://team.example.com/x\n",
        "  repo: backend\n",
    );
    let out = update_app_config_tools_text(doc, &[Tool::Codex]).expect("rewrite ok");
    let a = app(&out);
    assert_eq!(a.spec_dir.as_deref(), Some("docs/specs"));
    let r = a.remote.as_ref().expect("remote section kept");
    assert_eq!(r.url.as_deref(), Some("https://team.example.com/x"));
    assert_eq!(r.repo.as_deref(), Some("backend"));
    // claude 落选移除；descriptor 原样保留（保序）；codex 新入选 append 尾端。
    assert_eq!(a.tools.len(), 2);
    match &a.tools[0] {
        ToolEntry::Descriptor(d) => {
            assert_eq!(d.name.as_deref(), Some("wad-harness"));
            assert_eq!(d.skills_dir.as_deref(), Some(".wad/skills"));
            assert_eq!(d.instructions_file.as_deref(), Some("WAD.md"));
        }
        other => panic!("expected descriptor first, got {other:?}"),
    }
    assert!(matches!(&a.tools[1], ToolEntry::Builtin(s) if s == "codex"));
    // 描述子的未知字段也逐字保留（raw value carry-over）。
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    let tools = m.get("tools").and_then(|v| v.as_sequence()).expect("tools seq");
    assert_eq!(
        tools[0].get("future_field").and_then(|v| v.as_str()),
        Some("keep me")
    );
}

#[test]
fn tools_update_bad_yaml_is_a_loud_error() {
    for bad in ["tools: [unclosed", "just a top-level scalar"] {
        assert!(
            update_app_config_tools_text(bad, &[Tool::Claude]).is_err(),
            "must reject {bad:?}"
        );
    }
}

#[test]
fn tools_update_creates_tools_key_when_absent() {
    for doc in ["", "spec_dir: docs/specs\n"] {
        let out = update_app_config_tools_text(doc, &[Tool::Claude]).expect("rewrite ok");
        let a = app(&out);
        assert_eq!(a.tools.len(), 1, "for input {doc:?}");
        assert!(matches!(&a.tools[0], ToolEntry::Builtin(s) if s == "claude"));
    }
}

/// Spec example「built-in 选集转换」第三列（codex → claude,codex）：两者都在且不重复，
/// 同时锁住 Implementation Contract 的「其他键保持可解析且值不变」——包含未知顶层键。
#[test]
fn tools_update_adds_missing_builtin_and_keeps_unknown_top_level_keys() {
    let doc = concat!(
        "tools:\n",
        "  - codex\n",
        "  - name: wad-harness\n",
        "    skills_dir: .wad/skills\n",
        "    instructions_file: WAD.md\n",
        "future_top_level: keep me\n",
    );
    let out = update_app_config_tools_text(doc, &[Tool::Claude, Tool::Codex]).expect("rewrite ok");
    let a = app(&out);
    let builtins: Vec<&str> = a
        .tools
        .iter()
        .filter_map(|e| match e {
            ToolEntry::Builtin(s) => Some(s.as_str()),
            ToolEntry::Descriptor(_) => None,
        })
        .collect();
    assert_eq!(builtins, ["codex", "claude"], "既有项保序、新项 append，且不重复");
    assert!(a.tools.iter().any(|e| matches!(e, ToolEntry::Descriptor(_))));
    let m: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    assert_eq!(
        m.get("future_top_level").and_then(|v| v.as_str()),
        Some("keep me")
    );
}

#[test]
fn tools_update_empty_selection_keeps_descriptors_only() {
    let doc = "tools:\n  - claude\n  - name: wad-harness\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\n";
    let out = update_app_config_tools_text(doc, &[]).expect("rewrite ok");
    let a = app(&out);
    assert_eq!(a.tools.len(), 1);
    assert!(matches!(&a.tools[0], ToolEntry::Descriptor(_)));
}

fn mapping(text: &str) -> serde_yaml::Mapping {
    match serde_yaml::from_str::<serde_yaml::Value>(text).expect("parses") {
        serde_yaml::Value::Mapping(m) => m,
        other => panic!("expected a mapping, got {other:?}"),
    }
}

/// 锁定基准：`.specseal.yaml` 不存在时 `write_remote_section` 建档，且只写入
/// remote 键。
#[test]
fn write_remote_section_creates_the_file_with_only_the_remote_key() {
    let root = TempCfgDir::new("write-creates");
    write_remote_section(&root.dir, "https://example.test/store", Some("acme/specs"))
        .expect("writes");
    let doc = mapping(&root.read_app_yaml());
    assert_eq!(doc.len(), 1, "a fresh file carries only the remote section: {doc:?}");
    let remote = doc.get("remote").expect("remote section").clone();
    assert_eq!(
        remote,
        serde_yaml::from_str::<serde_yaml::Value>(
            "url: https://example.test/store\nrepo: acme/specs\n"
        )
        .unwrap()
    );
}

/// 锁定基准：写入与移除 remote section 都不动其他顶层键——`spec_dir`、描述子
/// 对象（含其字段）与未知键的值逐一保留。
#[test]
fn the_remote_section_verbs_keep_every_other_top_level_key() {
    let root = TempCfgDir::new("keeps-keys");
    let original = "spec_dir: docs/spec\n\
tools:\n\
  - claude\n\
  - name: my-harness\n\
    skills_dir: .my-harness/skills\n\
    invocation: tool-call\n\
future_key:\n\
  nested: value\n";
    root.app_yaml(original);
    let before = mapping(original);

    write_remote_section(&root.dir, "https://example.test/store", None).expect("writes");
    let after_write = mapping(&root.read_app_yaml());
    for key in ["spec_dir", "tools", "future_key"] {
        assert_eq!(
            after_write.get(key),
            before.get(key),
            "write_remote_section must keep '{key}' untouched"
        );
    }
    assert_eq!(
        after_write.get("remote"),
        Some(&serde_yaml::from_str::<serde_yaml::Value>("url: https://example.test/store\n").unwrap()),
        "a None repo writes url only"
    );

    assert!(remove_remote_section(&root.dir).expect("removes"), "the section was there");
    let after_remove = mapping(&root.read_app_yaml());
    assert!(after_remove.get("remote").is_none(), "the section is gone");
    for key in ["spec_dir", "tools", "future_key"] {
        assert_eq!(
            after_remove.get(key),
            before.get(key),
            "remove_remote_section must keep '{key}' untouched"
        );
    }
}

/// 锁定基准：非 mapping 的 `.specseal.yaml` 让两支动词以 `invalid .specseal.yaml`
/// 开头的单行错误失败，且不覆写用户的文件。
#[test]
fn the_remote_section_verbs_refuse_a_non_mapping_document_without_writing() {
    let root = TempCfgDir::new("non-mapping");
    let original = "- claude\n- codex\n";
    root.app_yaml(original);

    for message in [
        write_remote_section(&root.dir, "https://example.test/store", None)
            .expect_err("refuses")
            .to_string(),
        remove_remote_section(&root.dir).expect_err("refuses").to_string(),
    ] {
        assert!(
            message.starts_with("invalid .specseal.yaml"),
            "single-line error naming the file: {message}"
        );
        assert!(!message.contains('\n'), "the error stays one line: {message}");
    }
    assert_eq!(root.read_app_yaml(), original, "a refused verb writes nothing");
}

/// 锁定基准：没有 remote 键时 `remove_remote_section` 回 `Ok(false)`，文件比特级不变。
#[test]
fn remove_remote_section_is_a_no_op_without_a_remote_key() {
    let root = TempCfgDir::new("remove-noop");
    let original = "spec_dir: openspec\ntools:\n  - claude\n";
    root.app_yaml(original);
    assert!(!remove_remote_section(&root.dir).expect("no-op"), "nothing to remove");
    assert_eq!(root.read_app_yaml(), original, "the file is byte-identical");
}

// --- review 区块：typed 结构与严格解析（review-rules-config） ---

#[test]
fn review_absent_parses_as_extend_with_three_empty_lists() {
    // spec Scenario 未写 review 时为缺省：review 键缺席（或为 null）等同 extend 与三个空清单。
    for doc in ["schema: spec-driven\n", "schema: spec-driven\nreview:\n"] {
        let w = WorkflowConfig::from_text(Some(doc)).expect("parses");
        assert_eq!(w.review(), ReviewConfig::default(), "for {doc:?}");
    }
    let r = ReviewConfig::default();
    assert_eq!(r.baseline, ReviewBaseline::Extend);
    assert!(r.critical.is_empty() && r.warning.is_empty() && r.suggestion.is_empty());
}

#[test]
fn review_replace_with_three_lists_parses() {
    // spec Example 严格解析的拒收面：baseline: replace、critical: [x] → 正常读取。
    let w = WorkflowConfig::from_text(Some("review:\n  baseline: replace\n  critical: [x]\n"))
        .expect("parses");
    assert_eq!(w.review().baseline, ReviewBaseline::Replace);
    assert_eq!(w.review().critical, vec!["x".to_string()]);
    let doc = "review:\n  baseline: replace\n  critical:\n    - 所有 SQL 一律用参数化查找\n  warning:\n    - 添加的公开 API 要有对应的测试\n  suggestion:\n    - 函数超过 50 行时宜拆分\n";
    let r = WorkflowConfig::from_text(Some(doc)).expect("parses").review();
    assert_eq!(r.baseline, ReviewBaseline::Replace);
    assert_eq!(r.critical, vec!["所有 SQL 一律用参数化查找".to_string()]);
    assert_eq!(r.warning, vec!["添加的公开 API 要有对应的测试".to_string()]);
    assert_eq!(r.suggestion, vec!["函数超过 50 行时宜拆分".to_string()]);
    // 明写 extend 与省略同义。
    let r = WorkflowConfig::from_text(Some("review:\n  baseline: extend\n")).expect("parses").review();
    assert_eq!(r, ReviewConfig::default());
}

#[test]
fn review_baseline_parse_is_the_case_sensitive_inverse_of_as_str() {
    // review-ticket-applied-rules D3：工单的 `**Rules**:` 与 config 共用同一组 token。
    for b in [ReviewBaseline::Extend, ReviewBaseline::Replace] {
        assert_eq!(ReviewBaseline::parse(b.as_str()), Some(b));
    }
    for bad in ["Extend", "REPLACE", " extend", "strict", ""] {
        assert_eq!(ReviewBaseline::parse(bad), None, "{bad:?} must not parse");
    }
}

#[test]
fn review_strict_parse_rejects_and_names_the_offending_key_or_value() {
    // spec Example 严格解析的拒收面：未知子键、大小写不符的 baseline、清单写成对象。
    for (doc, needle) in [
        ("review:\n  critcal: [x]\n", "critcal"),
        ("review:\n  baseline: Replace\n", "Replace"),
        ("review:\n  baseline: keep\n", "keep"),
        ("review:\n  critical: {a: b}\n", "critical"),
    ] {
        let err = WorkflowConfig::from_text(Some(doc))
            .expect_err(&format!("{doc:?} must be a config error"));
        assert_eq!(err.file, "specseal/config.yaml", "for {doc:?}");
        assert!(err.reason.contains(needle), "reason must name {needle:?}, got: {}", err.reason);
    }
}

#[test]
fn review_unknown_top_level_keys_stay_ignored() {
    // 顶层不加 deny_unknown_fields：未知顶层键照旧略过，严格度只在 review 底下。
    let w = WorkflowConfig::from_text(Some("future_key: keep me\nreview:\n  warning: [w]\n"))
        .expect("unknown top-level keys are ignored");
    assert_eq!(w.review().warning, vec!["w".to_string()]);
}

// --- update_workflow_config_text：review 区块整块代换（review-rules-config） ---

fn review_cfg(
    baseline: ReviewBaseline,
    critical: &[&str],
    warning: &[&str],
    suggestion: &[&str],
) -> ReviewConfig {
    let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
    ReviewConfig {
        baseline,
        critical: list(critical),
        warning: list(warning),
        suggestion: list(suggestion),
    }
}

/// 政策字段回填现值、context 与 rules 不动，只交 review 变更集。
fn rewrite_review(doc: &str, review: Option<&ReviewConfig>) -> anyhow::Result<String> {
    update_workflow_config_text(doc, &wf_fields_of(doc), &ContentEdit { review, ..Default::default() })
}

/// review 键底下的原始 mapping（验「不写该键」用，typed 读取看不出键是否在场）。
fn raw_review(out: &str) -> Option<serde_yaml::Mapping> {
    let m: serde_yaml::Mapping = serde_yaml::from_str(out).expect("mapping");
    m.get("review").map(|v| v.as_mapping().expect("review is a mapping").clone())
}

#[test]
fn review_some_replaces_the_whole_block() {
    let doc = "schema: spec-driven\nreview:\n  critical:\n    - old rule\n  warning:\n    - old warning\n";
    let want = review_cfg(ReviewBaseline::Extend, &["new one", "new two"], &[], &[]);
    let out = rewrite_review(doc, Some(&want)).expect("rewrite ok");
    assert_eq!(WorkflowConfig::from_text(Some(&out)).expect("parses").review(), want);
}

#[test]
fn review_extend_writes_no_baseline_key_and_replace_does() {
    let doc = "schema: spec-driven\n";
    let out = rewrite_review(doc, Some(&review_cfg(ReviewBaseline::Extend, &["a"], &[], &[])))
        .expect("rewrite ok");
    assert!(!raw_review(&out).unwrap().contains_key("baseline"), "extend is the default: {out}");
    let out = rewrite_review(doc, Some(&review_cfg(ReviewBaseline::Replace, &["a"], &[], &[])))
        .expect("rewrite ok");
    assert_eq!(raw_review(&out).unwrap().get("baseline"), Some(&"replace".into()));
}

#[test]
fn review_empty_lists_are_not_written() {
    let out = rewrite_review(
        "schema: spec-driven\n",
        Some(&review_cfg(ReviewBaseline::Extend, &["a"], &[], &[])),
    )
    .expect("rewrite ok");
    let keys: Vec<String> = raw_review(&out)
        .unwrap()
        .keys()
        .map(|k| k.as_str().unwrap().to_string())
        .collect();
    assert_eq!(keys, vec!["critical".to_string()], "only the non-empty list is written: {out}");
}

#[test]
fn review_all_empty_removes_the_review_key() {
    // baseline 缺席（extend）且三个清单皆空 → 移除整个 review 键。
    let doc = "schema: spec-driven\nreview:\n  baseline: replace\n  critical:\n    - a\n";
    let out = rewrite_review(doc, Some(&ReviewConfig::default())).expect("rewrite ok");
    assert!(raw_review(&out).is_none(), "review key removed, got: {out}");
    assert_eq!(out, "schema: spec-driven\n");
    // 原本就没有 review：文件逐比特不变。
    let doc = "schema: spec-driven\nlocale: tw\n";
    assert_eq!(rewrite_review(doc, Some(&ReviewConfig::default())).unwrap(), doc);
    // replace 且三清单皆空：只留 baseline。
    let out = rewrite_review(doc, Some(&review_cfg(ReviewBaseline::Replace, &[], &[], &[])))
        .expect("rewrite ok");
    let review = raw_review(&out).expect("review kept for the baseline");
    assert_eq!(review.len(), 1, "only baseline: {out}");
}

#[test]
fn review_entries_are_trimmed_and_blank_entries_dropped() {
    let want = review_cfg(ReviewBaseline::Extend, &["  a  ", "", "   "], &["  "], &[]);
    let out = rewrite_review("{}", Some(&want)).expect("rewrite ok");
    let r = WorkflowConfig::from_text(Some(&out)).expect("parses").review();
    assert_eq!(r.critical, vec!["a".to_string()]);
    assert!(r.warning.is_empty() && !raw_review(&out).unwrap().contains_key("warning"));
}

#[test]
fn review_reserved_char_entries_round_trip_verbatim() {
    // spec Scenario 保留字符开头的条目自动加引号：读回逐字符一致。
    // 看起来像数字、布尔、null 的条目同样要加引号，否则读回时被严格解析拒收。
    for evil in ["@开头的规则", "`cargo test` 全绿", "*星号开头", "&锚点开头", "- 破折号开头", "1", "true", "null", "~"] {
        let want = review_cfg(ReviewBaseline::Extend, &[], &[evil], &[]);
        let out = rewrite_review("schema: spec-driven\n", Some(&want)).expect("rewrite ok");
        let r = WorkflowConfig::from_text(Some(&out))
            .unwrap_or_else(|e| panic!("{evil:?} must stay parseable: {e}"))
            .review();
        assert_eq!(r.warning, vec![evil.to_string()], "round-trip for {evil:?}");
    }
}

#[test]
fn review_write_preserves_every_other_line_byte_for_byte() {
    let prefix = "# lead comment\nschema: spec-driven\n\nlocale: tw\ntdd: true\ncontext: |\n  line one\n\nrules:\n  tasks:\n    - keep me\n\n# review comment stays\n";
    let doc = format!("{prefix}review:\n  critical:\n    - old rule # inline comment is not kept\n");
    let want = review_cfg(ReviewBaseline::Replace, &["new rule"], &["w"], &[]);
    let out = rewrite_review(&doc, Some(&want)).expect("rewrite ok");
    assert!(out.starts_with(prefix), "lines outside review are byte-identical, got:\n{out}");
    let w = WorkflowConfig::from_text(Some(&out)).expect("parses");
    assert_eq!(w.review(), want);
    assert_eq!(w.context, wf(&doc).context);
    assert_eq!(w.rules, wf(&doc).rules);
    assert_eq!((w.locale.as_deref(), w.tdd), (Some("tw"), Some(true)));
    // review 在中段时，其后的键也逐比特保留。
    let doc = "schema: spec-driven\nreview:\n  warning:\n    - old\nfuture_key: keep # tail\n";
    let out = rewrite_review(doc, Some(&review_cfg(ReviewBaseline::Extend, &[], &["new"], &[])))
        .expect("rewrite ok");
    assert!(out.starts_with("schema: spec-driven\nreview:\n"), "got:\n{out}");
    assert!(out.ends_with("\nfuture_key: keep # tail\n"), "got:\n{out}");
}

#[test]
fn review_write_on_a_crlf_document_keeps_crlf_line_endings() {
    let doc = "schema: spec-driven\r\nlocale: tw\r\nreview:\r\n  critical:\r\n    - old\r\n";
    let want = review_cfg(ReviewBaseline::Replace, &["a"], &["b"], &["c"]);
    let out = rewrite_review(doc, Some(&want)).expect("rewrite ok");
    assert_all_crlf(&out);
    assert!(out.starts_with("schema: spec-driven\r\nlocale: tw\r\n"), "got: {out:?}");
    assert_eq!(WorkflowConfig::from_text(Some(&out)).expect("parses").review(), want);
    // 添加（附加在档尾）的 review 区块同样沿用 CRLF。
    let out = rewrite_review("schema: spec-driven\r\n", Some(&want)).expect("rewrite ok");
    assert_all_crlf(&out);
}

#[test]
fn review_none_leaves_the_review_block_untouched() {
    let block = "review:\n  baseline: replace # keep this comment\n  critical:\n    - a\n";
    let doc = format!("schema: spec-driven\ncontext: old\n{block}");
    let out = update_workflow_config_text(
        &doc,
        &wf_fields_of(&doc),
        &ContentEdit { context: ContextEdit::Set("new".into()), ..Default::default() },
    )
    .expect("rewrite ok");
    assert!(out.ends_with(block), "review block verbatim, got:\n{out}");
    assert_eq!(wf(&out).context.as_deref(), Some("new"));
}

#[test]
fn review_non_string_entries_are_rejected_not_coerced() {
    // audit（review-rules-config 2.4）：serde_yaml 缺省把 1、true、空项目（null）转成
    // "1"、"true"、"null" 字符串——那会把不是规则的东西当成规则送进审查。清单项目必须
    // 是字符串，否则整份 config 拒收并点名该清单。
    for (doc, needle) in [
        ("review:\n  critical: [1, 2]\n", "review.critical"),
        ("review:\n  warning:\n    - true\n", "review.warning"),
        ("review:\n  suggestion:\n    -\n", "review.suggestion"),
    ] {
        let err = WorkflowConfig::from_text(Some(doc))
            .expect_err(&format!("{doc:?} must be a config error"));
        assert!(err.reason.contains(needle), "reason names {needle:?}, got: {}", err.reason);
    }
    // 加引号的数字是字符串；清单键留空（null）等同省略。
    let r = WorkflowConfig::from_text(Some("review:\n  critical: [\"1\"]\n  warning:\n"))
        .expect("parses")
        .review();
    assert_eq!(r.critical, vec!["1".to_string()]);
    assert!(r.warning.is_empty());
}

#[test]
fn review_entries_are_trimmed_and_blank_entries_dropped_on_read() {
    // review R10：读取即整理——手写的头尾空白与空字符串条目不进审查；CLI 改一条清单时
    // 原样写回的其他清单，值也就不会因写入接缝的整理而改变。多行规则保留内部换行。
    let doc = "review:\n  critical:\n    - \"  a  \"\n    - \"\"\n    - b\n  warning: [\"  \"]\n  suggestion:\n    - |\n      line one\n      line two\n";
    let r = WorkflowConfig::from_text(Some(doc)).expect("parses").review();
    assert_eq!(r.critical, vec!["a".to_string(), "b".to_string()]);
    assert!(r.warning.is_empty());
    assert_eq!(r.suggestion, vec!["line one\nline two".to_string()]);
}

/// 每个换行都是 CRLF，且没有重复的 CR（`replace("\r\n", "")` 抓不到 `\r\r\n`）。
fn assert_all_crlf(out: &str) {
    assert!(!out.contains("\r\r"), "no doubled CR: {out:?}");
    assert!(
        out.split('\n').rev().skip(1).all(|line| line.ends_with('\r')),
        "every line ends with CRLF: {out:?}"
    );
}

#[test]
fn every_block_write_on_a_crlf_document_keeps_crlf_line_endings() {
    // review R9：context、rules、review 三种区块都沿用文件的行尾——原地代换与附加在档尾皆然。
    let rules = vec![("tasks".to_string(), vec!["a".to_string(), "b".to_string()])];
    let review = review_cfg(ReviewBaseline::Replace, &["c"], &[], &[]);
    for doc in ["schema: spec-driven\r\nlocale: tw\r\n", "schema: spec-driven\r\ncontext: |\r\n  old\r\nrules:\r\n  tasks:\r\n    - old\r\nreview:\r\n  warning:\r\n    - old\r\n"] {
        for edit in [
            ContentEdit { context: ContextEdit::Set("line one\nline two\n".into()), ..Default::default() },
            ContentEdit { rules: Some(&rules), ..Default::default() },
            ContentEdit { review: Some(&review), ..Default::default() },
        ] {
            let out = update_workflow_config_text(doc, &wf_fields_of(doc), &edit).expect("rewrite ok");
            assert_all_crlf(&out);
        }
    }
    let doc = "schema: spec-driven\r\n";
    let edit = ContentEdit { context: ContextEdit::Set("line one\nline two\n".into()), ..Default::default() };
    let out = update_workflow_config_text(doc, &wf_fields_of(doc), &edit).expect("rewrite ok");
    assert_eq!(wf(&out).context.as_deref(), Some("line one\nline two\n"), "CRLF in a block scalar reads back as LF");
}

// --- subagent_model 区块：typed 结构与严格解析（station-subagent-model） ---

fn tool(name: &str) -> ToolName {
    ToolName::parse(name).expect("valid tool name")
}

fn model_map(pairs: &[(&str, &str)]) -> BTreeMap<ToolName, String> {
    pairs.iter().map(|(k, v)| (tool(k), v.to_string())).collect()
}

#[test]
fn subagent_model_absent_or_null_reads_as_three_empty_maps() {
    // spec Scenario 未写 subagent_model 时为缺省：缺席或 null 等同三个子键皆空。
    for doc in ["schema: spec-driven\n", "schema: spec-driven\nsubagent_model:\n"] {
        let w = WorkflowConfig::from_text(Some(doc)).expect("parses");
        assert_eq!(w.subagent_model(), SubagentModelConfig::default(), "for {doc:?}");
    }
    let s = SubagentModelConfig::default();
    assert!(s.review.is_empty() && s.verify.is_empty() && s.choices.is_empty());
}

#[test]
fn subagent_model_full_block_parses() {
    // spec Scenario --json 带出子代理模型设置的同一份区块。
    let doc = "subagent_model:\n  review:\n    claude: opus\n    codex: gpt-6.1-sol\n  verify:\n    claude: sonnet\n  choices:\n    codex:\n      - gpt-6.1-sol\n      - gpt-6-astra\n";
    let s = WorkflowConfig::from_text(Some(doc)).expect("parses").subagent_model();
    assert_eq!(s.review, model_map(&[("claude", "opus"), ("codex", "gpt-6.1-sol")]));
    assert_eq!(s.verify, model_map(&[("claude", "sonnet")]));
    assert_eq!(
        s.choices.get("codex"),
        Some(&vec!["gpt-6.1-sol".to_string(), "gpt-6-astra".to_string()])
    );
    assert_eq!(s.choices.len(), 1);
}

#[test]
fn subagent_model_strict_parse_rejects_and_names_the_offending_key_or_value() {
    // spec Example 严格解析的判定：拒收的五列，外加清单条目与 verify 值不是字符串。
    for (doc, needle) in [
        ("subagent_model:\n  reveiw: {claude: opus}\n", "reveiw"),
        ("subagent_model:\n  review: {Claude: opus}\n", "Claude"),
        ("subagent_model:\n  review: {claude: 3}\n", "claude"),
        ("subagent_model:\n  review: [claude]\n", "review"),
        ("subagent_model:\n  choices: {codex: gpt-6.1-sol}\n", "codex"),
        ("subagent_model:\n  choices: {codex: [1]}\n", "codex"),
        ("subagent_model:\n  verify: {claude: true}\n", "claude"),
        ("subagent_model:\n  verify: {claude_code: opus}\n", "claude_code"),
    ] {
        let err = WorkflowConfig::from_text(Some(doc))
            .expect_err(&format!("{doc:?} must be a config error"));
        assert_eq!(err.file, "specseal/config.yaml", "for {doc:?}");
        assert!(err.reason.contains(needle), "reason must name {needle:?}, got: {}", err.reason);
    }
}

#[test]
fn subagent_model_accepts_any_kebab_case_tool_and_unchecked_model_names() {
    // spec Example 严格解析的判定：正常读取的三列。
    let s = WorkflowConfig::from_text(Some(
        "subagent_model:\n  review: {claude: opus, my-agent: some-model}\n",
    ))
    .expect("parses")
    .subagent_model();
    assert_eq!(s.review, model_map(&[("claude", "opus"), ("my-agent", "some-model")]));
    let s = WorkflowConfig::from_text(Some("subagent_model:\n  review: {claude: not-a-real-model}\n"))
        .expect("model names are not checked")
        .subagent_model();
    assert_eq!(s.review, model_map(&[("claude", "not-a-real-model")]));
}

#[test]
fn subagent_model_blank_values_read_as_not_set_and_entries_are_trimmed() {
    // 空白或 null 的格子读作没设置；值去头尾空白；清单空白条目略过、null 清单读作空。
    let doc = "subagent_model:\n  review:\n    claude: \"  \"\n    codex:\n    copilot: \"  opus  \"\n  choices:\n    codex:\n      - \"  a  \"\n      - \"\"\n      - b\n    pi:\n";
    let s = WorkflowConfig::from_text(Some(doc)).expect("parses").subagent_model();
    assert_eq!(s.review, model_map(&[("copilot", "opus")]));
    assert_eq!(s.choices.get("codex"), Some(&vec!["a".to_string(), "b".to_string()]));
    assert!(!s.choices.contains_key("pi"), "an empty list is no custom list: {:?}", s.choices);
}

#[test]
fn subagent_model_unknown_top_level_keys_stay_ignored() {
    let w = WorkflowConfig::from_text(Some("future_key: x\nsubagent_model:\n  verify: {claude: sonnet}\n"))
        .expect("unknown top-level keys are ignored");
    assert_eq!(w.subagent_model().verify, model_map(&[("claude", "sonnet")]));
}

#[test]
fn builtin_subagent_models_list_only_the_claude_short_names() {
    assert_eq!(BUILTIN_SUBAGENT_MODELS, &[("claude", &["sonnet", "opus", "haiku", "fable"][..])]);
}

#[test]
fn tool_name_parse_follows_the_descriptor_kebab_case_rule() {
    for ok in ["claude", "codex", "my-agent", "a1"] {
        assert_eq!(ToolName::parse(ok).map(|t| t.to_string()), Ok(ok.to_string()), "{ok:?} is a valid tool name");
    }
    for bad in ["Claude", "a", "-x", "x-", "a--b", "claude_code", "", "my agent"] {
        let err = ToolName::parse(bad).expect_err(&format!("{bad:?} must be rejected"));
        assert!(err.contains("kebab-case"), "message names the rule, got: {err}");
    }
}

// --- update_workflow_config_text：subagent_model 区块整块代换（station-subagent-model） ---

fn subagent_cfg(review: &[(&str, &str)], verify: &[(&str, &str)], choices: &[(&str, &[&str])]) -> SubagentModelConfig {
    SubagentModelConfig {
        review: model_map(review),
        verify: model_map(verify),
        choices: choices
            .iter()
            .map(|(k, v)| (tool(k), v.iter().map(|s| s.to_string()).collect()))
            .collect(),
    }
}

/// 政策字段回填现值、其他区块不动，只交 subagent_model 变更集。
fn rewrite_subagent(doc: &str, s: &SubagentModelConfig) -> anyhow::Result<String> {
    update_workflow_config_text(doc, &wf_fields_of(doc), &ContentEdit { subagent_model: Some(s), ..Default::default() })
}

#[test]
fn subagent_model_some_replaces_the_whole_block() {
    let doc = "schema: spec-driven\nsubagent_model:\n  review:\n    claude: opus\n  verify:\n    codex: old\n";
    let want = subagent_cfg(&[("claude", "sonnet")], &[], &[("codex", &["gpt-6.1-sol", "gpt-6-astra"])]);
    let out = rewrite_subagent(doc, &want).expect("rewrite ok");
    assert_eq!(WorkflowConfig::from_text(Some(&out)).expect("parses").subagent_model(), want);
}

#[test]
fn subagent_model_cleans_blank_values_and_empty_lists() {
    let want = subagent_cfg(&[("claude", "  opus  "), ("codex", "   ")], &[], &[("codex", &["  a  ", "", " "]), ("pi", &[])]);
    let out = rewrite_subagent("schema: spec-driven\n", &want).expect("rewrite ok");
    let raw: serde_yaml::Mapping = serde_yaml::from_str(&out).expect("mapping");
    let block = raw.get("subagent_model").and_then(|v| v.as_mapping()).expect("block written");
    let review = block.get("review").and_then(|v| v.as_mapping()).expect("review written");
    assert_eq!(review.len(), 1, "the blank codex cell is not written: {out}");
    assert!(!block.contains_key("verify"), "an empty station is not written: {out}");
    let s = WorkflowConfig::from_text(Some(&out)).expect("parses").subagent_model();
    assert_eq!(s, subagent_cfg(&[("claude", "opus")], &[], &[("codex", &["a"])]));
}

#[test]
fn subagent_model_all_empty_removes_the_key() {
    let doc = "schema: spec-driven\nsubagent_model:\n  review:\n    claude: opus\n";
    let out = rewrite_subagent(doc, &SubagentModelConfig::default()).expect("rewrite ok");
    assert_eq!(out, "schema: spec-driven\n");
    let doc = "schema: spec-driven\nlocale: tw\n";
    assert_eq!(rewrite_subagent(doc, &SubagentModelConfig::default()).unwrap(), doc, "absent stays absent");
}

#[test]
fn subagent_model_tools_are_written_in_alphabetical_order() {
    let want = subagent_cfg(&[("codex", "b"), ("claude", "a"), ("my-agent", "c")], &[], &[]);
    let out = rewrite_subagent("schema: spec-driven\n", &want).expect("rewrite ok");
    let (claude, codex, mine) = (out.find("claude:").unwrap(), out.find("codex:").unwrap(), out.find("my-agent:").unwrap());
    assert!(claude < codex && codex < mine, "alphabetical order, got:\n{out}");
}

#[test]
fn subagent_model_reserved_char_names_round_trip_verbatim() {
    for evil in ["@model", "`x`", "*star", "- dash", "1", "true", "null", "~", "a: b"] {
        let want = subagent_cfg(&[("claude", evil)], &[], &[("codex", &[evil])]);
        let out = rewrite_subagent("schema: spec-driven\n", &want).expect("rewrite ok");
        let s = WorkflowConfig::from_text(Some(&out))
            .unwrap_or_else(|e| panic!("{evil:?} must stay parseable: {e}"))
            .subagent_model();
        assert_eq!(s, want, "round-trip for {evil:?}");
    }
}

#[test]
fn subagent_model_write_preserves_every_other_line_byte_for_byte() {
    let prefix = "# lead comment\nschema: spec-driven\n\nlocale: tw\ntdd: true\ncontext: |\n  line one\n\nreview:\n  critical:\n    - keep me # stays\n\n";
    let doc = format!("{prefix}subagent_model:\n  review:\n    claude: opus # inline comment is not kept\n");
    let want = subagent_cfg(&[("claude", "sonnet")], &[("codex", "gpt-6.1-sol")], &[]);
    let out = rewrite_subagent(&doc, &want).expect("rewrite ok");
    assert!(out.starts_with(prefix), "lines outside subagent_model are byte-identical, got:\n{out}");
    assert_eq!(WorkflowConfig::from_text(Some(&out)).expect("parses").subagent_model(), want);
    // 区块在中段时，其后的键也逐比特保留。
    let doc = "schema: spec-driven\nsubagent_model:\n  verify:\n    claude: old\nfuture_key: keep # tail\n";
    let out = rewrite_subagent(doc, &want).expect("rewrite ok");
    assert!(out.ends_with("\nfuture_key: keep # tail\n"), "got:\n{out}");
}

#[test]
fn subagent_model_write_on_a_crlf_document_keeps_crlf_line_endings() {
    let want = subagent_cfg(&[("claude", "opus")], &[], &[("codex", &["a", "b"])]);
    for doc in [
        "schema: spec-driven\r\nlocale: tw\r\n",
        "schema: spec-driven\r\nsubagent_model:\r\n  review:\r\n    claude: old\r\nlocale: tw\r\n",
    ] {
        let out = rewrite_subagent(doc, &want).expect("rewrite ok");
        assert_all_crlf(&out);
        assert_eq!(WorkflowConfig::from_text(Some(&out)).expect("parses").subagent_model(), want);
    }
}

#[test]
fn subagent_model_none_leaves_the_block_untouched() {
    let block = "subagent_model:\n  review:\n    claude: opus # keep this comment\n";
    let doc = format!("schema: spec-driven\ncontext: old\n{block}");
    let out = update_workflow_config_text(
        &doc,
        &wf_fields_of(&doc),
        &ContentEdit { context: ContextEdit::Set("new".into()), ..Default::default() },
    )
    .expect("rewrite ok");
    assert!(out.ends_with(block), "subagent_model block verbatim, got:\n{out}");
}

#[test]
fn subagent_model_duplicate_tool_names_fail_closed() {
    // review R1-W2：serde 的 BTreeMap 遇到重复键会留最后一个；读取端要和写入端一样拒收，
    // 不能让手改出的两行 claude 静默只剩一行。
    for (doc, needle) in [
        ("subagent_model:\n  review:\n    claude: opus\n    claude: sonnet\n", "claude"),
        ("subagent_model:\n  verify:\n    codex: a\n    codex: b\n", "codex"),
        ("subagent_model:\n  choices:\n    pi: [a]\n    pi: [b]\n", "pi"),
    ] {
        let err = WorkflowConfig::from_text(Some(doc))
            .expect_err(&format!("{doc:?} must be a config error"));
        assert!(err.reason.contains("duplicate") && err.reason.contains(needle), "reason names the tool, got: {}", err.reason);
    }
}

// --- changed_keys：写入前后解析结果的差异键（workflow-config-commands D2）---

/// `before` 为 None 代表文件原本不存在。
fn keys_between(before: Option<&str>, after: &str) -> Vec<String> {
    let before = WorkflowConfig::from_text(before).expect("before parses");
    let after = WorkflowConfig::from_text(Some(after)).expect("after parses");
    changed_keys(&before, &after).iter().map(ToString::to_string).collect()
}

#[test]
fn policy_keys_parse_back_from_their_names_and_nothing_else() {
    for key in PolicyKey::ALL {
        assert_eq!(PolicyKey::parse(key.as_str()), Some(key));
    }
    assert_eq!(PolicyKey::list(), "locale, spec_locale, tdd, audit, worktree");
    for word in ["schema", "TDD", " tdd", ""] {
        assert_eq!(PolicyKey::parse(word), None, "{word:?}");
    }
}

const KEYS_BASE: &str = "schema: spec-driven\nlocale: tw\ntdd: false\n";

#[test]
fn changed_keys_match_the_spec_example_table() {
    // Spec workflow-config「流程设置的写入经命令运行层」Example「各种编辑的变动键」（逐列）。
    let rows: [(&str, String, &str); 6] = [
        ("set locale ja", "schema: spec-driven\nlocale: ja\ntdd: false\n".to_string(), "locale"),
        ("context 取代成新的文本", format!("{KEYS_BASE}context: |\n  new text\n"), "context"),
        (
            "rules proposal 取代成两条规则",
            format!("{KEYS_BASE}rules:\n  proposal:\n  - one\n  - two\n"),
            "rules.proposal",
        ),
        (
            "review critical 取代成一条规则",
            format!("{KEYS_BASE}review:\n  critical:\n  - one\n"),
            "review.critical",
        ),
        ("review baseline replace", format!("{KEYS_BASE}review:\n  baseline: replace\n"), "review.baseline"),
        (
            "subagent-model review claude opus",
            format!("{KEYS_BASE}subagent_model:\n  review:\n    claude: opus\n"),
            "subagent_model.review",
        ),
    ];
    for (edit, after, key) in rows {
        assert_eq!(keys_between(Some(KEYS_BASE), &after), [key], "{edit}");
    }
}

#[test]
fn changed_keys_reports_a_toggle_that_moved() {
    // Spec scenario「set 回报变动的键」：tdd false → true。
    assert_eq!(keys_between(Some("tdd: false\n"), "tdd: true\n"), ["tdd"]);
    // false 不落键：缺席与 false 是同一个状态，不算变动。
    assert_eq!(keys_between(Some("schema: spec-driven\n"), "schema: spec-driven\ntdd: false\n"), [""; 0]);
}

#[test]
fn changed_keys_is_empty_when_only_layout_or_comments_changed() {
    let before = "schema: spec-driven\nlocale: tw\nrules:\n  tasks:\n  - one\n";
    let after = "# a new comment\nschema:   spec-driven\n\nlocale: \"tw\"   # trailing\nrules:\n  tasks: [one]\n";
    assert_eq!(keys_between(Some(before), after), [""; 0]);
}

#[test]
fn changed_keys_lists_every_set_key_when_the_file_did_not_exist() {
    let after = "schema: my-flow\nlocale: ja\naudit: true\ncontext: hi\nrules:\n  tasks:\n  - one\nreview:\n  warning:\n  - w\n";
    assert_eq!(
        keys_between(None, after),
        ["schema", "locale", "audit", "context", "rules.tasks", "review.warning"]
    );
}

#[test]
fn changed_keys_come_back_in_the_fixed_order() {
    let before = "rules:\n  tasks:\n  - gone\n";
    let after = "\
subagent_model:
  choices:
    codex: [a]
  verify:
    claude: sonnet
  review:
    claude: opus
review:
  suggestion: [s]
  warning: [w]
  critical: [c]
  baseline: replace
rules:
  specs: [r]
  design: [r]
context: text
worktree: true
audit: true
tdd: true
spec_locale: auto
locale: ja
schema: my-flow
";
    assert_eq!(
        keys_between(Some(before), after),
        [
            "schema",
            "locale",
            "spec_locale",
            "tdd",
            "audit",
            "worktree",
            "context",
            "rules.design",
            "rules.specs",
            "rules.tasks",
            "review.baseline",
            "review.critical",
            "review.warning",
            "review.suggestion",
            "subagent_model.review",
            "subagent_model.verify",
            "subagent_model.choices",
        ]
    );
}
