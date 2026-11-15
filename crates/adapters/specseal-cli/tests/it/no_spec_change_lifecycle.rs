//! 内置 schema `no-spec-change` 的变更生命周期 — fs 模式契约（spec workflow-schemas
//! 「no-spec-change 内置 schema 的组成」）。
//!
//! 一个变更走完 new → status → instructions → validate → archive：没有 specs artifact、
//! proposal 范本没有 Capabilities、validate 不警告缺 delta、封存不需要 `--skip-specs`
//! 且正式规格不变。user 层 schema 位置导进暂存项目，开发者的 home 不影响结果。

use std::path::PathBuf;
use std::process::{Command, Output};

const CANON: &str = "# demo Specification\n\n## Purpose\n\nDemo capability used as the untouched canonical spec in this test.\n\n## Requirements\n\n### Requirement: Demo works\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn new(tag: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-no-spec-change-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("specseal").join("specs").join("demo")).unwrap();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        std::fs::write(dir.join("specseal").join("specs").join("demo").join("spec.md"), CANON)
            .unwrap();
        TempProject { dir }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(args)
            .current_dir(&self.dir)
            .env("NO_COLOR", "1")
            .env("HOME", self.dir.join("home"))
            .env("USERPROFILE", self.dir.join("home"))
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .output()
            .expect("run specseal binary")
    }

    fn change_dir(&self) -> PathBuf {
        self.dir.join("specseal").join("changes").join("tidy")
    }

    /// 正式规格目录的全部文件（相对路径, 内容），排序后供前后比对。
    fn canonical_snapshot(&self) -> Vec<(String, String)> {
        let root = self.dir.join("specseal").join("specs");
        let mut out = Vec::new();
        for cap in std::fs::read_dir(&root).unwrap().flatten() {
            for f in std::fs::read_dir(cap.path()).unwrap().flatten() {
                let rel = format!(
                    "{}/{}",
                    cap.file_name().to_string_lossy(),
                    f.file_name().to_string_lossy()
                );
                out.push((rel, std::fs::read_to_string(f.path()).unwrap()));
            }
        }
        out.sort();
        out
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn ok(out: &Output, what: &str) -> String {
    assert!(
        out.status.success(),
        "{what} failed: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
fn a_no_spec_change_change_runs_from_new_to_archive_without_touching_specs() {
    let p = TempProject::new("lifecycle");
    let before = p.canonical_snapshot();

    // 创建：schemaName、artifact 串行与 applyRequires 都来自内置定义，没有 specs。
    ok(&p.run(&["new", "change", "tidy", "--schema", "no-spec-change"]), "new change");
    let status: serde_json::Value =
        serde_json::from_str(&ok(&p.run(&["status", "--change", "tidy", "--json"]), "status"))
            .expect("status --json");
    assert_eq!(status["schemaName"], "no-spec-change");
    let ids: Vec<&str> = status["artifacts"]
        .as_array()
        .expect("artifacts")
        .iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    assert_eq!(ids, ["proposal", "design", "tasks"]);
    assert_eq!(status["applyRequires"], serde_json::json!(["tasks"]));

    // proposal 范本：有 Why／What Changes／Impact，没有 Capabilities。
    let proposal: serde_json::Value = serde_json::from_str(&ok(
        &p.run(&["instructions", "proposal", "--change", "tidy", "--json"]),
        "instructions proposal",
    ))
    .expect("instructions --json");
    let template = proposal["template"].as_str().expect("template");
    for section in ["## Why", "## What Changes", "## Impact"] {
        assert!(template.contains(section), "template 须含 {section}：{template}");
    }
    assert!(!template.contains("## Capabilities"), "template 不得含 Capabilities：{template}");
    let instruction = proposal["instruction"].as_str().expect("instruction");
    assert!(
        instruction.contains("list the canonical specs you checked"),
        "instruction 要求 Why 列出查过的正式规格：{instruction}"
    );

    // validate：没有 delta 也不警告。
    std::fs::write(
        p.change_dir().join("proposal.md"),
        "## Why\n\nRename an internal helper. It alters no behavior the canonical specs promise; checked: demo.\n\n## What Changes\n\n- Rename the helper.\n\n## Impact\n\n- src/helper.rs\n",
    )
    .unwrap();
    std::fs::write(
        p.change_dir().join("tasks.md"),
        "## 1. Refactor\n\n- [x] 1.1 Rename the helper\n- [x] 1.2 Run the existing tests to confirm the demo behavior is unchanged\n",
    )
    .unwrap();
    let validated = p.run(&["validate", "tidy", "--json"]);
    let validated = ok(&validated, "validate");
    assert!(!validated.contains("No delta specs found"), "不得警告缺 delta：{validated}");
    let human = ok(&p.run(&["validate", "tidy"]), "validate (human)");
    assert!(!human.contains("No delta specs found"), "人眼输出也不警告：{human}");
    // 同一项目没有 delta 的 spec-driven 变更照现行输出该警告。
    ok(&p.run(&["new", "change", "other"]), "new change other");
    let other = ok(&p.run(&["validate", "other", "--json"]), "validate other");
    assert!(other.contains("No delta specs found"), "spec-driven 照旧警告：{other}");

    // 封存：不带 --skip-specs 也成功，正式规格逐档不变。
    ok(&p.run(&["archive", "tidy"]), "archive");
    assert!(!p.change_dir().exists(), "变更移出 changes/");
    let archived = std::fs::read_dir(p.dir.join("specseal").join("changes").join("archive"))
        .expect("archive dir")
        .flatten()
        .any(|e| e.file_name().to_string_lossy().ends_with("-tidy"));
    assert!(archived, "变更移入封存目录");
    assert_eq!(p.canonical_snapshot(), before, "specseal/specs/ 不得有任何变动");
}
