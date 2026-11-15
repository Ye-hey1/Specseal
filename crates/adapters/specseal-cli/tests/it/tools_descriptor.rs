//! Integration tests for custom tool descriptors in `.specseal.yaml` `tools:`.
//!
//! Pinned behavior: `specseal update` generates skills for a valid
//! descriptor (exit 0); validation failures exit non-zero with a single-line semantic
//! error naming the field; removing a descriptor from `tools:` prunes its footprint
//! (skill dirs, any legacy marker block, empty files/dirs) on the next update.

use std::path::PathBuf;
use std::process::{Command, Output};

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn new(tag: &str, app_yaml: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-descriptor-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("specseal").join("changes")).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), app_yaml).unwrap();
        TempProject { dir }
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.dir.join(rel.split('/').collect::<PathBuf>());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.dir.join(rel.split('/').collect::<PathBuf>())).unwrap()
    }

    fn exists(&self, rel: &str) -> bool {
        self.dir.join(rel.split('/').collect::<PathBuf>()).exists()
    }

    fn update(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_specseal"))
            .args(["update"])
            .current_dir(&self.dir)
            .output()
            .expect("run specseal binary")
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const WAD_DESCRIPTOR: &str = "tools:\n  - name: wad-harness\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\n    invocation: tool-call\n";

fn stderr_line(out: &Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    let lines: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines.len(), 1, "expected exactly one stderr line, got: {err:?}");
    lines[0].to_string()
}

// --- generation ---

#[test]
fn valid_descriptor_generates_skills_and_no_instruction_file() {
    // Spec scenario 合法描述子生成对应工具档：技能档生成、exit 0，
    // 且不生成任何指令档区块。
    let p = TempProject::new("generate", WAD_DESCRIPTOR);
    let out = p.update();

    assert!(
        out.status.success(),
        "update must succeed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        p.exists(".wad/skills/specseal-apply/SKILL.md"),
        "skills_dir must receive specseal-*/SKILL.md files"
    );
    assert!(!p.exists("WAD.md"), "instructions_file must not be generated");
}

#[test]
fn descriptor_without_instructions_file_is_accepted() {
    // Spec requirement「tools 自订描述子的接受与验证」：instructions_file 选填。
    let p = TempProject::new(
        "no-instructions-file",
        "tools:\n  - name: wad-harness\n    skills_dir: .wad/skills\n    invocation: tool-call\n",
    );
    let out = p.update();

    assert!(
        out.status.success(),
        "descriptor without instructions_file must be accepted: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(p.exists(".wad/skills/specseal-apply/SKILL.md"));
    assert!(
        String::from_utf8_lossy(&out.stderr).trim().is_empty(),
        "no deprecation notice when the field is absent"
    );
}

#[test]
fn a_leftover_instructions_file_field_gets_a_deprecation_notice() {
    // Spec scenario「残留 instructions_file 字段得弃用提示」：exit 0、技能档照常
    // 生成，stderr 带一行弃用提示指明该字段已不生效。
    let p = TempProject::new("deprecated-field", WAD_DESCRIPTOR);
    let out = p.update();

    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(p.exists(".wad/skills/specseal-apply/SKILL.md"));
    let line = stderr_line(&out);
    assert!(
        line.contains("instructions_file") && line.contains("deprecated"),
        "the notice must name the deprecated field: {line}"
    );
}

// --- validation failures: non-zero exit + single semantic line naming the field ---

#[test]
fn builtin_name_conflict_is_rejected() {
    // Spec scenario 名称与内置工具冲突被拒.
    let p = TempProject::new(
        "conflict",
        "tools:\n  - name: claude\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\n",
    );
    let out = p.update();

    assert!(!out.status.success(), "exit code must be non-zero");
    let line = stderr_line(&out);
    assert!(line.contains("name"), "must name the field: {line}");
    assert!(line.contains("claude"), "must name the conflicting value: {line}");
}

#[test]
fn path_escaping_project_root_is_rejected() {
    // Spec scenario 路径逸出项目根被拒.
    let p = TempProject::new(
        "escape",
        "tools:\n  - name: wad-harness\n    skills_dir: ../outside/skills\n    instructions_file: WAD.md\n",
    );
    let out = p.update();

    assert!(!out.status.success(), "exit code must be non-zero");
    let line = stderr_line(&out);
    assert!(line.contains("skills_dir"), "must name the field: {line}");
    assert!(
        !p.dir.parent().unwrap().join("outside").exists(),
        "nothing may be written outside the project root"
    );
}

#[test]
fn unknown_invocation_is_rejected() {
    let p = TempProject::new(
        "invocation",
        "tools:\n  - name: wad-harness\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\n    invocation: http\n",
    );
    let out = p.update();

    assert!(!out.status.success(), "exit code must be non-zero");
    let line = stderr_line(&out);
    assert!(line.contains("invocation"), "must name the field: {line}");
}

#[test]
fn update_reports_stripped_files_on_stdout() {
    // Spec scenario「更新时剥除内置工具的遗留 marker」的 stdout 面：摘要列出被剥除
    // 的文件（core 只断言 UpdateOutcome.stripped，这里钉 CLI 的输出行）。
    let p = TempProject::new("strip-stdout", "tools:\n  - claude\n");
    p.write(
        "CLAUDE.md",
        "<!-- SPECSEAL:START v1.0.0 -->\n旧路由表\n<!-- SPECSEAL:END -->\n用户段落\n",
    );

    let out = p.update();

    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("Stripped legacy Specseal blocks from: CLAUDE.md"),
        "stdout 须列出剥除文件：{stdout}"
    );
    assert_eq!(p.read("CLAUDE.md"), "用户段落\n");
}

// --- removal cleanup ---

#[test]
fn removed_descriptor_footprint_is_pruned() {
    // Spec scenario 移除描述子后生成物被清理: generated dir removed, any legacy
    // marker stripped, a file left empty is deleted.
    let p = TempProject::new("prune", WAD_DESCRIPTOR);
    // 旧版引擎注入过的纯 marker 档——描述子下架时要被整份清掉。
    p.write("WAD.md", "<!-- SPECSEAL:START v1.0.0 -->\n\n旧路由表。\n\n<!-- SPECSEAL:END -->\n");
    assert!(p.update().status.success());
    assert!(p.exists(".wad/skills/specseal-apply/SKILL.md"));

    p.write(".specseal.yaml", "tools:\n  - claude\n");
    let out = p.update();

    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!p.exists(".wad/skills"), "specseal-* skill dirs and empty parents removed");
    assert!(!p.exists(".wad"), "empty descriptor dirs are removed entirely");
    assert!(!p.exists("WAD.md"), "marker-only instructions file is deleted");
}

#[test]
fn removed_descriptor_keeps_user_content_in_instructions_file() {
    let p = TempProject::new("prune-user-content", WAD_DESCRIPTOR);
    // 先让描述子登记足迹（下架时的清理目标由此而来）。
    assert!(p.update().status.success());
    // 再摆回一份旧版引擎注入过的文件：marker 在上、用户段落在下。
    p.write(
        "WAD.md",
        "<!-- SPECSEAL:START v1.0.0 -->\n\n旧路由表。\n\n<!-- SPECSEAL:END -->\n# My own harness notes\n\nKeep me.\n",
    );

    p.write(".specseal.yaml", "tools: []\n");
    assert!(p.update().status.success());

    let md = p.read("WAD.md");
    assert!(!md.contains("<!-- SPECSEAL:START"), "marker stripped: {md}");
    assert!(md.contains("Keep me."), "user content preserved: {md}");
}
