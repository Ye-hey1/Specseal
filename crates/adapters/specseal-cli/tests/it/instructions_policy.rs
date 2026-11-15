//! Integration tests: the instructions payload takes its policy values (locale, tdd,
//! audit) from the THREE-LAYER resolution (env > `specseal/config.yaml` > default) —
//! `.specseal.yaml` policy keys are inert and warning-free. The toggles surface
//! inside the existing `instruction` text, locale in the existing `locale` field.

use std::path::PathBuf;
use std::process::{Command, Output};

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn new(tag: &str, app_yaml: &str, wf_yaml: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-instr-policy-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let change = dir.join("specseal").join("changes").join("demo-change");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), app_yaml).unwrap();
        std::fs::write(dir.join("specseal").join("config.yaml"), wf_yaml).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), "- [ ] 1.1 Do the thing\n").unwrap();
        TempProject { dir }
    }

    fn instructions(&self, artifact: &str, envs: &[(&str, &str)]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(["instructions", artifact, "--change", "demo-change", "--json"])
            .current_dir(&self.dir);
        for key in [
            "SPECSEAL_LOCALE",
            "SPECSEAL_SPEC_LOCALE",
            "SPECSEAL_TDD",
            "SPECSEAL_AUDIT",
        ] {
            cmd.env_remove(key);
        }
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd.output().expect("run specseal binary")
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn json_payload(out: &Output) -> serde_json::Value {
    assert!(
        out.status.success(),
        "command failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("stdout is JSON")
}

fn instruction_text(payload: &serde_json::Value) -> String {
    payload["instruction"].as_str().unwrap_or_default().to_string()
}

#[test]
fn canonical_config_yaml_toggles_reach_the_tasks_instruction() {
    // Spec scenario 正典值生效: policy only in specseal/config.yaml.
    let p = TempProject::new(
        "canonical",
        "tools:\n  - claude\n",
        "tdd: true\naudit: true\n",
    );
    let out = p.instructions("tasks", &[]);
    let payload = json_payload(&out);
    let instr = instruction_text(&payload);
    assert!(instr.contains("TDD"), "tasks instruction must carry the TDD discipline: {instr}");
    assert!(instr.contains("audit"), "tasks instruction must carry the audit discipline: {instr}");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "",
        "no warning on the policy path"
    );
}

#[test]
fn toggles_off_leave_the_instruction_untouched() {
    let p = TempProject::new("defaults", "tools:\n  - claude\n", "schema: spec-driven\n");
    let payload = json_payload(&p.instructions("tasks", &[]));
    let instr = instruction_text(&payload);
    assert!(!instr.contains("TDD"), "no TDD note when the toggle is off: {instr}");
    assert!(!instr.contains("audit"), "no audit note when the toggle is off: {instr}");
}

#[test]
fn app_policy_keys_are_inert_and_warning_free() {
    // Spec scenario .specseal.yaml 政策键一律不生效: app locale tw + tdd true vs
    // config.yaml locale ja (tdd unset) → canonical/default values, silent stderr.
    let p = TempProject::new(
        "app-inert",
        "locale: tw\ntdd: true\ntools:\n  - claude\n",
        "locale: ja\n",
    );
    let out = p.instructions("proposal", &[]);
    let payload = json_payload(&out);
    assert_eq!(payload["locale"].as_str().unwrap(), "Japanese (日本语)");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "",
        "an app policy key must not warn"
    );
    let out = p.instructions("tasks", &[]);
    let instr = instruction_text(&json_payload(&out));
    assert!(!instr.contains("TDD"), "app tdd key must stay inert: {instr}");
    assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "");
}

#[test]
fn env_var_overrides_both_files() {
    // Spec scenario 环境变量覆写正典值: SPECSEAL_TDD=false beats tdd: true in config.yaml.
    let p = TempProject::new(
        "env-wins",
        "tdd: true\ntools:\n  - claude\n",
        "tdd: true\n",
    );
    let payload = json_payload(&p.instructions("tasks", &[("SPECSEAL_TDD", "false")]));
    let instr = instruction_text(&payload);
    assert!(!instr.contains("TDD"), "env override must switch TDD off: {instr}");

    // And the locale env var beats the canonical value (the app key stays inert).
    let p = TempProject::new(
        "env-locale",
        "locale: tw\ntools:\n  - claude\n",
        "locale: ja\n",
    );
    let payload = json_payload(&p.instructions("proposal", &[("SPECSEAL_LOCALE", "en")]));
    assert_eq!(payload["locale"].as_str().unwrap(), "English");
}

#[test]
fn invalid_bool_env_var_falls_through_to_canonical_value() {
    // Spec scenario 非法布尔环境变量落到下一层: SPECSEAL_AUDIT=yes is ignored.
    let p = TempProject::new("invalid-env", "tools:\n  - claude\n", "audit: true\n");
    let out = p.instructions("tasks", &[("SPECSEAL_AUDIT", "yes")]);
    let payload = json_payload(&out);
    assert!(
        instruction_text(&payload).contains("audit"),
        "invalid env value must fall through to config.yaml's audit: true"
    );
}

#[test]
fn apply_payload_carries_effective_policy_values() {
    // Spec scenario fs 模式 payload 带有效值 + Example table tdd 有效值进 payload:
    // (SPECSEAL_TDD, config.yaml tdd) → payload tdd, audit riding along.
    let rows: &[(Option<&str>, &str, bool)] = &[
        (None, "tdd: true\n", true),
        (None, "", false),
        (Some("false"), "tdd: true\n", false),
        (Some("true"), "", true),
    ];
    for (i, (env_tdd, wf_yaml, want_tdd)) in rows.iter().enumerate() {
        let p = TempProject::new(&format!("apply-policy-{i}"), "tools:\n  - claude\n", wf_yaml);
        let envs: Vec<(&str, &str)> = env_tdd.iter().map(|v| ("SPECSEAL_TDD", *v)).collect();
        let payload = json_payload(&p.instructions("apply", &envs));
        assert_eq!(
            payload["tdd"].as_bool(),
            Some(*want_tdd),
            "row {i}: SPECSEAL_TDD={env_tdd:?}, config.yaml={wf_yaml:?}"
        );
        assert_eq!(payload["audit"].as_bool(), Some(false), "row {i}: audit defaults to false");
    }
    // audit follows the same resolution entry point.
    let p = TempProject::new("apply-policy-audit", "tools:\n  - claude\n", "audit: true\n");
    let payload = json_payload(&p.instructions("apply", &[]));
    assert_eq!(payload["audit"].as_bool(), Some(true));
}

#[test]
fn update_with_legacy_policy_keys_touches_no_config_and_stays_silent() {
    // Spec scenario 既有项目不受范本变更影响: update on a project whose
    // .specseal.yaml still carries old policy keys rewrites neither config file
    // and prints no deprecation warning (the warning mechanism is gone).
    let p = TempProject::new(
        "update-legacy",
        "locale: tw\ntdd: true\ntools:\n  - claude\n",
        "locale: ja\n",
    );
    let app_before = std::fs::read_to_string(p.dir.join(".specseal.yaml")).unwrap();
    let wf_before = std::fs::read_to_string(p.dir.join("specseal").join("config.yaml")).unwrap();

    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_specseal"));
    for key in [
        "SPECSEAL_LOCALE",
        "SPECSEAL_SPEC_LOCALE",
        "SPECSEAL_TDD",
        "SPECSEAL_AUDIT",
        "SPECSEAL_STORE_URL",
        "SPECSEAL_TOKEN",
    ] {
        cmd.env_remove(key);
    }
    let out = cmd.arg("update").current_dir(&p.dir).output().expect("run specseal update");
    assert!(out.status.success(), "update failed: {}", String::from_utf8_lossy(&out.stderr));

    assert_eq!(
        std::fs::read_to_string(p.dir.join(".specseal.yaml")).unwrap(),
        app_before,
        "update must not rewrite .specseal.yaml"
    );
    assert_eq!(
        std::fs::read_to_string(p.dir.join("specseal").join("config.yaml")).unwrap(),
        wf_before,
        "update must not rewrite specseal/config.yaml"
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "",
        "no deprecation warning on stderr"
    );
}
