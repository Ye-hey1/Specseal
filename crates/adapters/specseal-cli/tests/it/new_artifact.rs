//! `specseal new artifact spec` 的 capability 命名主闸 — fs 模式契约
//! (spec capability-naming-guard「创建点主闸」「--new 旗标显性声明新 capability」)。
//!
//! 正典未收录的名称未带 `--new` 即拒绝：非零收尾、stderr 含近似建议与两条
//! 指引、不落盘；带 `--new` 照现行流程创建；命中正典名称时输出比特级不变；
//! `--json` 成功 payload 形状冻结，主闸拒绝时 stdout 无成功 payload。

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const META: &str = "schema: spec-driven\ncreated: 2026-08-20\n";
const DELTA: &str = "## Purpose\n\n测试用 delta。\n\n## ADDED Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n\n#### Scenario: ok\n\n- **WHEN** used\n- **THEN** works\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// 一个 change `demo` ＋正式规格 `auth`。
    fn new(tag: &str) -> TempProject {
        let dir = std::env::temp_dir()
            .join(format!("specseal-cli-new-artifact-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // macOS 的 temp dir 是 /var → /private/var 的 symlink；Windows 的
        // canonicalize 会加 \\?\ 前缀，跳过。
        let dir = if cfg!(windows) { dir } else { dir.canonicalize().unwrap() };
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(change.join(".meta.yaml"), META).unwrap();
        let auth = dir.join("specseal").join("specs").join("auth");
        std::fs::create_dir_all(&auth).unwrap();
        std::fs::write(
            auth.join("spec.md"),
            "# auth Specification\n\n## Purpose\n\nAuth session lifecycle.\n\n## Requirements\n\n### Requirement: R1\n\nIt SHALL work.\n",
        )
        .unwrap();
        TempProject { dir }
    }

    /// 跑 `specseal new artifact spec <cap> --change demo --stdin [extra...]`，
    /// stdin 喂一份合法 delta。
    fn new_spec(&self, cap: &str, extra: &[&str]) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(["new", "artifact", "spec", cap, "--change", "demo", "--stdin", "--no-color"])
            .args(extra)
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn specseal binary");
        child.stdin.take().unwrap().write_all(DELTA.as_bytes()).unwrap();
        child.wait_with_output().expect("run specseal binary")
    }

    fn delta_dir(&self, cap: &str) -> PathBuf {
        self.dir.join("specseal").join("changes").join("demo").join("specs").join(cap)
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn an_unlisted_capability_without_new_refuses_with_suggestions() {
    // spec Scenario「未收录名称未带 --new 遭拒且不落盘」。
    let p = TempProject::new("refuse");
    let out = p.new_spec("authentication", &[]);
    assert!(!out.status.success(), "unlisted capability must exit non-zero");
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(stderr.contains("authentication"), "点名候选: {stderr}");
    assert!(stderr.contains("auth"), "近似建议: {stderr}");
    assert!(stderr.contains("Auth session lifecycle."), "建议附 Purpose 首行: {stderr}");
    assert!(stderr.contains("exact name"), "指引一：沿用既有名: {stderr}");
    assert!(stderr.contains("--new"), "指引二：带 --new 重跑: {stderr}");
    assert!(!stderr.contains("\u{1b}["), "--no-color 下无色彩控制码: {stderr:?}");
    assert!(!p.delta_dir("authentication").exists(), "拒绝不落盘");
}

#[test]
fn the_new_flag_creates_the_declared_capability() {
    // spec Scenario「带 --new 创建新 capability 成功」。
    let p = TempProject::new("declare");
    let out = p.new_spec("token-rotation", &["--new"]);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(out.status.success(), "--new declares the capability: {stderr}");
    assert!(p.delta_dir("token-rotation").join("spec.md").exists(), "delta spec created");
}

#[test]
fn a_canonical_capability_keeps_the_exact_success_output() {
    // spec Scenario「命中正式规格名称照常放行」：输出与导入前比特级一致。
    let p = TempProject::new("canonical");
    let out = p.new_spec("auth", &[]);
    assert!(out.status.success(), "canonical name passes");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let path = p.delta_dir("auth").join("spec.md");
    assert_eq!(
        stdout,
        format!("✓ Created spec: {}\n  Content validated ✓\n", path.to_string_lossy()),
        "成功输出逐比特不变"
    );
}

#[test]
fn json_success_payload_keeps_its_frozen_shape() {
    // spec Scenario「带 --json 的成功与拒绝路径」：成功 payload 字段形状冻结。
    let p = TempProject::new("json-ok");
    let out = p.new_spec("auth", &["--json"]);
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("single-line JSON");
    let obj = v.as_object().expect("object payload");
    let keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["artifact", "change", "path", "status", "validated", "warnings"],
        "camelCase 字段集合不变: {stdout}"
    );
    assert_eq!(obj["artifact"], "spec");
    assert_eq!(obj["change"], "demo");
    assert_eq!(obj["status"], "created");
    assert_eq!(obj["validated"], true);
}

#[test]
fn json_refusal_emits_no_success_payload() {
    // spec Scenario「带 --json 的成功与拒绝路径」：拒绝时非零收尾、stdout
    // 无成功 payload。
    let p = TempProject::new("json-refuse");
    let out = p.new_spec("authentication", &["--json"]);
    assert!(!out.status.success(), "refusal exits non-zero under --json too");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(!stdout.contains("\"status\""), "stdout 无成功 payload: {stdout}");
}
