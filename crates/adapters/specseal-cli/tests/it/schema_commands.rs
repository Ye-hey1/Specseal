//! `specseal schemas` / `specseal schema …` — the workflow-schema management surface.
//!
//! Each built-in schema is parsed from one canonical document compiled into the binary, so
//! `schema fork <built-in>` must ship that document byte for byte and `schemas` must show
//! the document's own description. The user-level schema location is redirected into the
//! temp project (HOME / USERPROFILE) so a developer's real home directory cannot change a
//! result.

use std::path::PathBuf;
use std::process::{Command, Output};

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn new(tag: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-schema-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("specseal")).unwrap();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
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
            .output()
            .expect("run specseal binary")
    }

    fn schema_dir(&self, name: &str) -> PathBuf {
        self.dir.join("specseal").join("schemas").join(name)
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

/// The canonical built-in document, as a parsed mapping.
fn canonical() -> serde_yaml::Value {
    serde_yaml::from_str(specseal_core::schema::SPEC_DRIVEN_SCHEMA_YAML).expect("canonical yaml parses")
}

/// Each built-in and its canonical document.
const BUILTINS: [(&str, &str); 2] = [
    ("spec-driven", specseal_core::schema::SPEC_DRIVEN_SCHEMA_YAML),
    ("no-spec-change", specseal_core::schema::NO_SPEC_CHANGE_SCHEMA_YAML),
];

#[test]
fn fork_of_the_builtin_ships_the_canonical_document_verbatim() {
    let p = TempProject::new("fork-verbatim");

    for (name, yaml) in BUILTINS {
        let out = p.run(&["schema", "fork", name]);
        assert!(out.status.success(), "fork {name} failed: {}", stderr_of(&out));

        let dir = p.schema_dir(&format!("{name}-custom"));
        let forked = std::fs::read(dir.join("schema.yaml")).expect("forked schema.yaml exists");
        assert_eq!(forked, yaml.as_bytes(), "{name}: fork 产出必须与正典 YAML 逐字节相同");

        // templates/ 每份档对应一个 artifact 声明的 template，内容与内嵌资产逐字相同。
        let builtin = specseal_core::schema::builtin(name).expect("built-in resolves");
        let mut want: Vec<&str> =
            builtin.artifacts.iter().map(|a| a.template_name.as_str()).collect();
        want.sort();
        let mut got: Vec<String> = std::fs::read_dir(dir.join("templates"))
            .expect("templates/ exists")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        got.sort();
        assert_eq!(got, want, "{name}: templates/ 的文件");
        for art in &builtin.artifacts {
            let body = std::fs::read_to_string(dir.join("templates").join(&art.template_name))
                .expect("template file exists");
            assert_eq!(Some(body.as_str()), art.template.as_deref(), "{name}: {}", art.template_name);
        }
    }
    let nsc = p.schema_dir("no-spec-change-custom").join("templates");
    assert_eq!(std::fs::read_dir(nsc).unwrap().count(), 3, "no-spec-change 带三份 template");
}

#[test]
fn the_builtin_description_comes_from_the_canonical_document() {
    let p = TempProject::new("description");

    let out = p.run(&["schemas", "--json"]);
    assert!(out.status.success(), "schemas failed: {}", stderr_of(&out));

    let listed: serde_json::Value = serde_json::from_slice(&out.stdout).expect("schemas --json");
    let listed = listed.as_array().expect("listing is an array");
    let builtins: Vec<(&str, &str)> = listed
        .iter()
        .take(2)
        .map(|e| (e["name"].as_str().unwrap_or(""), e["source"].as_str().unwrap_or("")))
        .collect();
    assert_eq!(builtins, [("spec-driven", "package"), ("no-spec-change", "package")]);

    let canon = canonical();
    let want = canon["description"].as_str().expect("canonical description");
    assert!(
        want.contains("design optional"),
        "正典 description 应点名 design 为选配：{want}"
    );
    assert_eq!(listed[0]["description"].as_str(), Some(want));
    assert_eq!(
        listed[1]["description"].as_str(),
        Some("No-spec-change workflow - proposal → tasks (design optional), for changes that alter no promised behavior")
    );
    assert_eq!(listed[1]["artifacts"], serde_json::json!(["proposal", "design", "tasks"]));

    let human = p.run(&["schemas"]);
    let text = String::from_utf8_lossy(&human.stdout);
    assert!(
        text.contains("  no-spec-change (package) — No-spec-change workflow"),
        "人眼输出列出 no-spec-change：{text}"
    );
}

#[test]
fn fork_and_init_refuse_a_name_that_is_not_kebab_case() {
    let p = TempProject::new("name-format");

    let cases: [&[&str]; 2] = [
        &["schema", "init", "My_Schema"],
        &["schema", "fork", "spec-driven", "My_Schema"],
    ];
    for args in cases {
        let out = p.run(args);
        assert!(
            !out.status.success(),
            "{args:?} 应以非 0 exit code 拒绝，实得成功"
        );
        let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), stderr_of(&out));
        assert!(
            said.contains("lowercase kebab-case"),
            "{args:?} 的消息须说明名称格式：{said}"
        );
        assert!(
            !p.schema_dir("My_Schema").exists(),
            "{args:?} 被拒后不得留下目录"
        );
    }
}

#[test]
fn init_accepts_a_kebab_case_name() {
    let p = TempProject::new("name-ok");

    let out = p.run(&["schema", "init", "my-flow"]);
    assert!(out.status.success(), "init failed: {}", stderr_of(&out));
    assert!(p.schema_dir("my-flow").join("schema.yaml").is_file());
}

/// A minimal, valid custom schema plus its template file.
fn write_custom_schema(p: &TempProject, name: &str, template_body: Option<&str>) {
    let dir = p.schema_dir(name);
    std::fs::create_dir_all(dir.join("templates")).unwrap();
    std::fs::write(
        dir.join("schema.yaml"),
        format!(
            "name: {name}\nversion: 1\nartifacts:\n- id: plan\n  generates: plan.md\n  \
             description: The plan\n  template: plan.md\n"
        ),
    )
    .unwrap();
    if let Some(body) = template_body {
        std::fs::write(dir.join("templates").join("plan.md"), body).unwrap();
    }
}

#[test]
fn which_all_lists_every_schema_with_its_resolution() {
    let p = TempProject::new("which-all");
    write_custom_schema(&p, "my-flow", Some("# plan\n"));

    let out = p.run(&["schema", "which", "--all", "--json"]);
    assert!(out.status.success(), "which --all failed: {}", stderr_of(&out));

    let listed: serde_json::Value = serde_json::from_slice(&out.stdout).expect("which --all --json");
    let rows = listed.as_array().expect("listing is an array");
    let names: Vec<&str> = rows.iter().filter_map(|r| r["name"].as_str()).collect();
    assert_eq!(names, ["spec-driven", "no-spec-change", "my-flow"], "内置在前、项目自订在后");

    for name in ["spec-driven", "no-spec-change"] {
        let builtin = rows.iter().find(|r| r["name"] == name).unwrap();
        assert_eq!(builtin["resolved"].as_str(), Some("built-in"), "{name}");
    }
    let custom = rows.iter().find(|r| r["name"] == "my-flow").unwrap();
    assert_eq!(custom["resolved"].as_str(), Some("project"));
    let source = custom["sources"][0]["path"].as_str().expect("source path");
    assert!(source.contains("my-flow"), "来源路径应指向该 schema：{source}");
}

#[test]
fn validate_reports_a_missing_template_file() {
    let p = TempProject::new("validate-template");
    write_custom_schema(&p, "no-template", None);

    let out = p.run(&["schema", "validate", "no-template"]);
    assert!(!out.status.success(), "缺 template 档应以非 0 exit code 结束");
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), stderr_of(&out));
    assert!(said.contains("plan.md"), "消息须指名缺席的 template 档：{said}");
}

#[test]
fn validate_verbose_prints_each_check() {
    let p = TempProject::new("validate-verbose");
    write_custom_schema(&p, "my-flow", Some("# plan\n"));

    let out = p.run(&["schema", "validate", "my-flow", "--verbose"]);
    assert!(out.status.success(), "validate failed: {}", stderr_of(&out));
    let said = String::from_utf8_lossy(&out.stdout).to_string();
    for step in ["parse", "artifact ids", "dependency references", "cycles", "templates"] {
        assert!(said.contains(step), "--verbose 须逐项印出「{step}」：{said}");
    }
}

#[test]
fn init_default_sets_the_project_schema_and_preserves_the_rest() {
    let p = TempProject::new("init-default");
    let config = p.dir.join("specseal").join("config.yaml");
    let original = "# a leading comment\nlocale: tw\ntdd: true\n";
    std::fs::write(&config, original).unwrap();

    let out = p.run(&["schema", "init", "my-flow", "--default"]);
    assert!(out.status.success(), "init --default failed: {}", stderr_of(&out));

    let after = std::fs::read_to_string(&config).unwrap();
    assert!(
        after.contains("schema: my-flow"),
        "config.yaml 应带 schema: my-flow：{after}"
    );
    for kept in ["# a leading comment", "locale: tw", "tdd: true"] {
        assert!(after.contains(kept), "既有内容 {kept} 须逐字保留：{after}");
    }
}

#[test]
fn init_default_creates_the_config_when_it_is_absent() {
    let p = TempProject::new("init-default-absent");
    let config = p.dir.join("specseal").join("config.yaml");
    assert!(!config.exists());

    let out = p.run(&["schema", "init", "my-flow", "--default"]);
    assert!(out.status.success(), "init --default failed: {}", stderr_of(&out));
    assert_eq!(std::fs::read_to_string(&config).unwrap(), "schema: my-flow\n");
}

#[test]
fn init_produces_a_skeleton_that_loads_and_validates() {
    let p = TempProject::new("init-skeleton");

    let out = p.run(&["schema", "init", "my-flow"]);
    assert!(out.status.success(), "init failed: {}", stderr_of(&out));

    // The default description carries a colon; an unquoted scalar would make the
    // document unparseable and every verb would then refuse the schema.
    let listed = p.run(&["schemas", "--json"]);
    let listed: serde_json::Value = serde_json::from_slice(&listed.stdout).expect("schemas --json");
    let entry = listed
        .as_array()
        .expect("listing is an array")
        .iter()
        .find(|e| e["name"] == "my-flow")
        .expect("my-flow is listed");
    assert_eq!(
        entry["artifacts"],
        serde_json::json!(["plan", "tasks"]),
        "骨架的 artifact 清单须读得出来（文档可解析）"
    );

    for (template, body) in [("plan.md", "# plan\n"), ("tasks.md", "# tasks\n")] {
        let path = p.schema_dir("my-flow").join("templates").join(template);
        assert_eq!(
            std::fs::read_to_string(&path).ok().as_deref(),
            Some(body),
            "骨架 template {template} 的内容须为标题行"
        );
    }
    let yaml = std::fs::read_to_string(p.schema_dir("my-flow").join("schema.yaml")).unwrap();
    assert!(yaml.contains("apply:"), "schema.yaml 须含 apply 区块：{yaml}");

    let validated = p.run(&["schema", "validate", "my-flow"]);
    assert!(
        validated.status.success(),
        "init 产出须通过自身 validate: {}",
        stderr_of(&validated)
    );
}

#[test]
fn init_default_refuses_when_the_config_cannot_be_read() {
    let p = TempProject::new("init-default-unreadable");
    let config = p.dir.join("specseal").join("config.yaml");
    // 非 UTF-8 内容：文件存在但读取失败——与「缺席」是两回事，不得被当成空白覆写。
    std::fs::write(&config, [0xFF, 0xFE, b'x']).unwrap();
    let before = std::fs::read(&config).unwrap();

    let out = p.run(&["schema", "init", "my-flow", "--default"]);
    assert!(!out.status.success(), "读不到的 config 应中止而非覆写");
    assert_eq!(std::fs::read(&config).unwrap(), before, "config.yaml 一个字节都不得动");
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), stderr_of(&out));
    assert!(said.contains("unchanged"), "消息须说明缺省未设：{said}");
    assert!(
        p.schema_dir("my-flow").join("schema.yaml").is_file(),
        "骨架本身仍应创建（契约：骨架已建、缺省未设）"
    );
}

#[test]
fn init_refuses_artifact_ids_that_escape_or_collide() {
    let p = TempProject::new("init-artifact-ids");

    let esc = p.run(&["schema", "init", "esc", "--artifacts", "../x"]);
    assert!(!esc.status.success(), "路径逸出的 artifact id 应被拒");
    assert!(!p.schema_dir("esc").exists(), "被拒后不得留下任何文件");

    let dup = p.run(&["schema", "init", "dup", "--artifacts", "plan,plan"]);
    assert!(!dup.status.success(), "重复 artifact id 应被拒");
    let said = format!("{}{}", String::from_utf8_lossy(&dup.stdout), stderr_of(&dup));
    assert!(said.contains("Duplicate artifact ID"), "{said}");
    assert!(!p.schema_dir("dup").exists(), "被拒后不得留下任何文件");
}

#[test]
fn init_survives_a_description_with_newlines() {
    let p = TempProject::new("init-multiline-desc");

    let out = p.run(&["schema", "init", "ml", "--description", "line one\nline two: colon"]);
    assert!(out.status.success(), "init failed: {}", stderr_of(&out));
    let v = p.run(&["schema", "validate", "ml"]);
    assert!(
        v.status.success(),
        "多行 description 的骨架必须通过 validate: {}",
        stderr_of(&v)
    );
}

#[test]
fn which_all_deduplicates_a_shadowed_name() {
    let p = TempProject::new("which-all-shadow");
    // 项目自订一个与内置同名的 schema——解析时 project 屏蔽 built-in。
    write_custom_schema(&p, "spec-driven", Some("# plan\n"));

    let out = p.run(&["schema", "which", "--all", "--json"]);
    assert!(out.status.success(), "which --all failed: {}", stderr_of(&out));
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let rows = rows.as_array().expect("listing is an array");
    let matches: Vec<_> = rows.iter().filter(|r| r["name"] == "spec-driven").collect();
    assert_eq!(matches.len(), 1, "同名 schema 只列一列：{rows:?}");
    assert_eq!(matches[0]["resolved"].as_str(), Some("project"), "解析结果是胜出者");
    let sources = matches[0]["sources"].as_array().expect("sources");
    assert_eq!(sources.len(), 2, "被屏蔽的 built-in 一并列出：{sources:?}");
    assert_eq!(sources[1]["source"].as_str(), Some("built-in"));
}

#[test]
fn a_project_schema_shadows_the_no_spec_change_builtin() {
    let p = TempProject::new("which-shadow-nsc");
    write_custom_schema(&p, "no-spec-change", Some("# plan\n"));

    let out = p.run(&["schema", "which", "no-spec-change", "--json"]);
    assert!(out.status.success(), "which failed: {}", stderr_of(&out));
    let row: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(row["resolved"].as_str(), Some("project"));
    let path = row["sources"][0]["path"].as_str().expect("project path");
    assert!(
        path.ends_with("schema.yaml") && path.contains("no-spec-change"),
        "解析结果指向项目层的 schema.yaml：{path}"
    );

    let out = p.run(&["schema", "which", "--all", "--json"]);
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let row = rows
        .as_array()
        .expect("listing is an array")
        .iter()
        .find(|r| r["name"] == "no-spec-change")
        .expect("no-spec-change is listed");
    let sources: Vec<&str> = row["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .filter_map(|s| s["source"].as_str())
        .collect();
    assert_eq!(sources, ["project", "built-in"], "被屏蔽的内置一并列出");
}
