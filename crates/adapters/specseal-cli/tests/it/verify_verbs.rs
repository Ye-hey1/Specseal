//! `specseal verify` 子命令家族的集成覆盖（design D3／D8）：scope／add-round／
//! show／show --json（camelCase payload 对外契约）／stamp [--accept]／discard 的
//! exit code 与 stdout/stderr 去向，archive 的验证工单三处置与 `--carry-verify`，
//! 以及两站 snapshot namespace 的清理隔离。
//!
//! 验证站的刻意不对称（design D3）在此钉死：任务未全数完成时 `verify add-round`
//! 拒绝——工单语意限定为成品验证，盘点轮不落工单。

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const ROUND_WITH_FINDINGS: &str =
    "**Scope**: src/lib.rs\n\n- [CRITICAL] src/lib.rs — requirement R2 has no implementation\n";
const SUGGESTION_ROUND: &str =
    "**Scope**: src/lib.rs\n\n- [SUGGESTION] src/lib.rs — design says otherwise\n";
const CLEAN_ROUND: &str = "**Scope**: src/lib.rs\n";
const TASKS_DONE: &str = "- [x] 1.1 first\n- [x] 1.2 second\n";
const TASKS_PARTIAL: &str = "- [x] 1.1 first\n- [ ] 1.2 second\n";

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    fn with_change(tag: &str, tasks: &str) -> TempProject {
        let dir =
            std::env::temp_dir().join(format!("specseal-cli-verify-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let change = dir.join("specseal").join("changes").join("demo");
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(change.join(".meta.yaml"), "schema: spec-driven\ncreated: 2026-07-01\n")
            .unwrap();
        std::fs::write(change.join("tasks.md"), tasks).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("lib.rs"), "fn demo() {}\n").unwrap();
        TempProject { dir }
    }

    fn with_git_change(tag: &str, tasks: &str) -> TempProject {
        let p = TempProject::with_change(tag, tasks);
        p.git(&["init", "-q"]);
        p.git(&["config", "user.name", "Sandbox Tester"]);
        p.git(&["config", "user.email", "sandbox@example.com"]);
        p.git(&["add", "-A"]);
        p.git(&["commit", "-q", "-m", "init"]);
        p
    }

    fn git(&self, args: &[&str]) {
        let ok = Command::new("git")
            .args(args)
            .current_dir(&self.dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    fn write(&self, rel: &str, content: &str) {
        let p = self.dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    fn scope_dir(&self) -> PathBuf {
        self.dir.join(".specseal").join("review-scopes").join("demo")
    }

    fn baseline_path(&self) -> PathBuf {
        self.scope_dir().join("baseline.json")
    }

    fn touched(&self, change: &str, files: &[&str]) {
        let dir = self.dir.join(".specseal").join("touched");
        std::fs::create_dir_all(&dir).unwrap();
        let files_json: Vec<String> = files.iter().map(|f| format!("\"{f}\"")).collect();
        std::fs::write(
            dir.join(format!("{change}.json")),
            format!(
                "{{\"version\":2,\"change\":\"{change}\",\"touched\":[{{\"task_id\":\"1\",\"task_desc\":\"t\",\"files\":[{}]}}]}}",
                files_json.join(",")
            ),
        )
        .unwrap();
    }

    /// 该站 snapshot 目录的档数（不存在读作 0）。
    fn snapshot_count(&self, station_dir: &str) -> usize {
        std::fs::read_dir(self.scope_dir().join(station_dir)).map(|it| it.count()).unwrap_or(0)
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_specseal"));
        c.args(args)
            .current_dir(&self.dir)
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN");
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().expect("run specseal binary")
    }

    fn run_stdin(&self, args: &[&str], input: &str) -> Output {
        let mut child = self
            .cmd(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn specseal binary");
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        child.wait_with_output().expect("wait specseal binary")
    }

    fn ticket_path(&self) -> PathBuf {
        self.dir.join("specseal").join("changes").join("demo").join("verify.md")
    }

    fn review_ticket_path(&self) -> PathBuf {
        self.dir.join("specseal").join("changes").join("demo").join("review.md")
    }

    fn meta(&self) -> String {
        std::fs::read_to_string(
            self.dir.join("specseal").join("changes").join("demo").join(".meta.yaml"),
        )
        .unwrap()
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stdout_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).to_string()
}

// --- verify add-round（design D3：引擎守门）---

#[test]
fn add_round_refuses_until_every_code_task_is_done() {
    // spec Scenario「写码任务未完成即拒绝落工单」：部分完成 → 非零、stderr 说明
    // 验证工单要求写码任务全数完成、无文件创建。（`[M]` 放行的一面在
    // manual_task_gates 钉住。）
    let p = TempProject::with_change("addround-partial", TASKS_PARTIAL);
    let out = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    assert!(!out.status.success(), "incomplete code tasks → non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("1/2"), "stderr shows the count: {err}");
    assert!(err.contains("code task"), "message names code tasks: {err}");
    assert!(!p.ticket_path().exists(), "refusal must not create the ticket");
    assert!(stdout_of(&out).is_empty(), "errors go to stderr only");
}

#[test]
fn add_round_creates_the_ticket_and_reports_the_round() {
    // spec Scenario「首轮创建工单」：exit 0、verify.md 创建且含 Round 1。
    let p = TempProject::with_change("addround", TASKS_DONE);
    let out = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(stdout_of(&out).contains("Round 1"), "stdout confirms: {}", stdout_of(&out));
    let doc = std::fs::read_to_string(p.ticket_path()).expect("ticket created");
    assert!(doc.starts_with("# Verify — demo\n"), "{doc}");
    assert!(doc.contains("## Round 1"), "{doc}");
}

#[test]
fn add_round_appends_without_rewriting_earlier_rounds() {
    // spec Scenario「追加轮次不改写既有轮」：Round 1 比特级不变。
    let p = TempProject::with_change("addround-append", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let before = std::fs::read_to_string(p.ticket_path()).unwrap();
    let out = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], CLEAN_ROUND);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let after = std::fs::read_to_string(p.ticket_path()).unwrap();
    assert!(after.starts_with(&before), "append-only\nbefore: {before}\nafter: {after}");
    assert!(after.contains("## Round 2"), "{after}");
}

#[test]
fn add_round_without_scope_fails_and_writes_nothing() {
    // spec Scenario「内容缺少 Scope」：非零、stderr 说明格式要求、工单不创建。
    let p = TempProject::with_change("addround-noscope", TASKS_DONE);
    let out = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], "- just prose\n");
    assert!(!out.status.success());
    assert!(stderr_of(&out).contains("**Scope**:"), "stderr explains: {}", stderr_of(&out));
    assert!(!p.ticket_path().exists(), "refusal must not create the ticket");
}

#[test]
fn add_round_line_suffixed_path_on_a_fresh_change_creates_no_ticket() {
    // spec「验证 finding 路径落在工单范围内」Scenario 带行号的路径被拒。
    let p = TempProject::with_change("addround-lineno", TASKS_DONE);
    let out = p.run_stdin(
        &["verify", "add-round", "demo", "--stdin"],
        "**Scope**: src/lib.rs\n\n- [WARNING] src/lib.rs:7-9 — Correctness: off by one\n",
    );
    assert!(!out.status.success(), "line-suffixed path → non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("src/lib.rs:7-9") && err.contains("line number"), "{err}");
    assert!(!p.ticket_path().exists(), "refusal must not create the ticket");
}

#[test]
fn add_round_out_of_scope_path_leaves_the_ticket_byte_identical() {
    let p = TempProject::with_change("addround-outscope", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let before = std::fs::read(p.ticket_path()).unwrap();
    let out = p.run_stdin(
        &["verify", "add-round", "demo", "--stdin"],
        "**Scope**: src/lib.rs\n\n- [WARNING] src/caller.rs — Completeness: caller unchanged\n",
    );
    assert!(!out.status.success(), "out-of-scope path → non-zero");
    let err = stderr_of(&out);
    assert!(err.contains("src/caller.rs") && err.contains("scope"), "{err}");
    assert_eq!(std::fs::read(p.ticket_path()).unwrap(), before, "zero write");
}

#[test]
fn add_round_accepts_a_finding_anchored_on_a_delta_spec() {
    // Scenario 锚定在 delta 规格档的 finding 可接受；stdout 与既有输出相同。
    let p = TempProject::with_change("addround-delta", TASKS_DONE);
    let out = p.run_stdin(
        &["verify", "add-round", "demo", "--stdin"],
        "**Scope**: src/lib.rs\n\n\
         - [CRITICAL] specseal/changes/demo/specs/auth/spec.md — Completeness: Requirement not found: 登录逾时\n",
    );
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(
        stdout_of(&out).trim_end(),
        "✓ Recorded verification Round 1 for change 'demo'",
        "success output unchanged"
    );
    let doc = std::fs::read_to_string(p.ticket_path()).unwrap();
    assert!(doc.contains("Requirement not found: 登录逾时"), "{doc}");
}

#[test]
fn structured_sequence_allows_one_discovery_then_validation_only() {
    // spec Scenario「第二个 discovery 被拒绝」＋「追加 structured validation」＋
    // 「phase 与 patch 必须成对」。
    let p = TempProject::with_change("addround-seq", TASKS_DONE);
    let round = |phase: &str, hex: &str| {
        format!("**Phase**: {phase}\n**Patch**: sha256:{hex}\n**Scope**: src/lib.rs\n")
    };
    let a = "a".repeat(64);
    let b = "b".repeat(64);

    let unpaired = p.run_stdin(
        &["verify", "add-round", "demo", "--stdin"],
        "**Phase**: discovery\n**Scope**: src/lib.rs\n",
    );
    assert!(!unpaired.status.success(), "Phase without Patch must be rejected");
    assert!(!p.ticket_path().exists(), "refusal writes nothing");

    let first = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], &round("discovery", &a));
    assert!(first.status.success(), "stderr: {}", stderr_of(&first));
    let after_first = std::fs::read_to_string(p.ticket_path()).unwrap();

    let second = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], &round("discovery", &b));
    assert!(!second.status.success(), "a second discovery must be rejected");
    assert!(stderr_of(&second).contains("validation"), "{}", stderr_of(&second));
    assert_eq!(std::fs::read_to_string(p.ticket_path()).unwrap(), after_first, "ticket unchanged");

    let third = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], &round("validation", &b));
    assert!(third.status.success(), "stderr: {}", stderr_of(&third));
    assert!(std::fs::read_to_string(p.ticket_path()).unwrap().contains("## Round 2"));
}

// --- verify show ---

#[test]
fn show_prints_the_ticket_without_ansi_under_no_color() {
    let p = TempProject::with_change("show-human", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let out = p.run(&["--no-color", "verify", "show", "demo"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let text = stdout_of(&out);
    assert!(text.contains("Round 1"), "{text}");
    assert!(text.contains("src/lib.rs"), "{text}");
    assert!(!text.contains('\u{1b}'), "--no-color must strip ANSI: {text:?}");
}

#[test]
fn show_json_payload_carries_the_camel_case_contract() {
    // spec「验证工单的读取」：change／rounds[].index／phase／patchHash／scope／
    // findings[].severity|path|text／lastRound，字段 camelCase 且类型固定。
    let p = TempProject::with_change("show-json", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], CLEAN_ROUND);
    let out = p.run(&["verify", "show", "demo", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid JSON");
    assert_eq!(v["change"], "demo");
    let rounds = v["rounds"].as_array().expect("rounds array");
    assert_eq!(rounds.len(), 2);
    assert_eq!(rounds[0]["index"], 1);
    assert_eq!(rounds[0]["scope"], serde_json::json!(["src/lib.rs"]));
    let f = &rounds[0]["findings"][0];
    assert_eq!(f["severity"], "CRITICAL");
    assert_eq!(f["path"], "src/lib.rs");
    assert!(f["text"].is_string(), "{f}");
    assert_eq!(v["lastRound"]["index"], 2);
    assert_eq!(v["lastRound"]["findings"].as_array().map(Vec::len), Some(0));
}

#[test]
fn show_json_legacy_round_emits_explicit_nulls() {
    // spec Scenario「legacy JSON 使用 null」：不含 Phase／Patch 的轮次两栏明确
    // 输出 null（缺栏与 null 对读取端是两件事）。
    let p = TempProject::with_change("show-json-legacy", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], CLEAN_ROUND);
    let out = p.run(&["verify", "show", "demo", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid JSON");
    assert!(v["rounds"][0]["phase"].is_null(), "{v}");
    assert!(v["rounds"][0]["patchHash"].is_null(), "{v}");
    assert!(v["lastRound"]["phase"].is_null(), "{v}");
    // spec Scenario「没有规则记录的工单输出 null」：rules 键在、值为 null（验证技能不写规则行）。
    assert_eq!(v["rounds"][0].get("rules"), Some(&serde_json::Value::Null), "{v}");
}

#[test]
fn show_json_carries_nullable_phase_and_patch_hash() {
    // spec Scenario「读取 JSON」：structured 工单的 lastRound.phase 为 validation
    // 且 patchHash 为 `sha256:` digest。
    let p = TempProject::with_change("show-json-structured", TASKS_DONE);
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    p.run_stdin(
        &["verify", "add-round", "demo", "--stdin"],
        &format!("**Phase**: discovery\n**Patch**: sha256:{a}\n**Scope**: src/lib.rs\n"),
    );
    p.run_stdin(
        &["verify", "add-round", "demo", "--stdin"],
        &format!("**Phase**: validation\n**Patch**: sha256:{b}\n**Scope**: src/lib.rs\n"),
    );
    let out = p.run(&["verify", "show", "demo", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid JSON");
    assert_eq!(v["rounds"][0]["phase"], "discovery");
    assert_eq!(v["lastRound"]["phase"], "validation");
    assert_eq!(v["lastRound"]["patchHash"], format!("sha256:{b}"));
    // spec Scenario「没有规则记录的工单输出 null」：structured 轮同样每轮带 rules: null。
    for round in v["rounds"].as_array().expect("rounds array") {
        assert_eq!(round.get("rules"), Some(&serde_json::Value::Null), "{v}");
    }
    assert_eq!(v["lastRound"].get("rules"), Some(&serde_json::Value::Null), "{v}");
}

#[test]
fn show_without_ticket_fails_semantically() {
    // spec Scenario「无工单」：非零、stderr 说明该 change 无「验证」工单。
    let p = TempProject::with_change("show-none", TASKS_DONE);
    let out = p.run(&["verify", "show", "demo"]);
    assert!(!out.status.success());
    let err = stderr_of(&out);
    assert!(err.contains("no verify ticket"), "stderr names the station: {err}");
}

// --- verify stamp / discard ---

#[test]
fn stamp_refuses_findings_without_accept_then_accepts() {
    // spec Scenario「末轮有未解 findings 且未带 --accept」＋`--accept` 豁免。
    let p = TempProject::with_change("stamp-findings", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let refused = p.run(&["verify", "stamp", "demo"]);
    assert!(!refused.status.success());
    let err = stderr_of(&refused);
    assert!(err.contains("--accept"), "stderr offers --accept: {err}");
    assert!(err.contains("re-verify"), "station word is the verify one: {err}");
    assert!(err.contains("1 outstanding must-fix"), "stderr names the must-fix count: {err}");
    assert!(err.contains("CRITICAL/WARNING"), "stderr names the blocking severities: {err}");
    assert!(p.ticket_path().exists(), "ticket survives the refusal");

    let ok = p.run(&["verify", "stamp", "demo", "--accept"]);
    assert!(ok.status.success(), "stderr: {}", stderr_of(&ok));
    assert!(!p.ticket_path().exists(), "ticket deleted by the stamp");
    assert!(p.meta().contains("verified_at"), "{}", p.meta());
}

#[test]
fn stamp_allows_a_suggestion_only_round() {
    // spec Scenario「仅 SUGGESTION 的末轮干净盖章」：SUGGESTION 不是必修，
    // 无 --accept 也放行——exit 0、五栏写入、工单删除。
    let p = TempProject::with_change("stamp-suggestion", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], SUGGESTION_ROUND);
    let out = p.run(&["verify", "stamp", "demo", "--agent", "claude"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(!p.ticket_path().exists(), "ticket deleted by the stamp");
    let meta = p.meta();
    for key in ["verified_at:", "verified_tasks_total:", "verified_scope:", "verified_with:"] {
        assert!(meta.contains(key), "missing {key}: {meta}");
    }
    // spec「盖章记录验证轮数」：一轮的工单盖章写入 verified_rounds: 1，盖章时间是 RFC 3339。
    assert_eq!(meta.matches("verified_rounds: ").count(), 1, "{meta}");
    assert!(meta.contains("verified_rounds: 1\n"), "{meta}");
    let at = meta.lines().find_map(|l| l.strip_prefix("verified_at: ")).expect("verified_at");
    assert!(chrono::DateTime::parse_from_rfc3339(at).is_ok(), "verified_at is RFC 3339: {meta}");
}

#[test]
fn stamp_refuses_incomplete_tasks() {
    // 守门 (1)：工单开立后任务被退勾 → 非零，消息用 verify 的动词。
    let p = TempProject::with_change("stamp-partial", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], CLEAN_ROUND);
    p.write("specseal/changes/demo/tasks.md", TASKS_PARTIAL);
    let out = p.run(&["verify", "stamp", "demo"]);
    assert!(!out.status.success());
    let err = stderr_of(&out);
    assert!(err.contains("1/2"), "{err}");
    assert!(err.contains("verify stamp"), "names the verb: {err}");
    assert!(!p.meta().contains("verified_at"), "{}", p.meta());
}

#[test]
fn stamp_clean_round_writes_the_anchors_and_deletes_the_ticket() {
    // spec Scenario「干净盖章」：五个 verified 字段齐备、工单不存在。
    let p = TempProject::with_change("stamp-clean", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], CLEAN_ROUND);
    let out = p.run(&["verify", "stamp", "demo", "--agent", "claude"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(!p.ticket_path().exists());
    let meta = p.meta();
    for key in ["verified_at:", "verified_tasks_total:", "verified_scope:", "verified_with:"] {
        assert!(meta.contains(key), "missing {key}: {meta}");
    }
    assert!(meta.contains("verified_tasks_total: 2"), "{meta}");
}

#[test]
fn discard_removes_the_ticket_and_leaves_metadata_alone() {
    // spec Scenario「放弃既有工单」：exit 0、verify.md 不存在、meta 不变。
    let p = TempProject::with_change("discard", TASKS_DONE);
    let before = p.meta();
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let out = p.run(&["verify", "discard", "demo"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert!(!p.ticket_path().exists());
    assert_eq!(p.meta(), before, "metadata untouched");

    let again = p.run(&["verify", "discard", "demo"]);
    assert!(!again.status.success(), "no ticket → non-zero");
}

// --- archive 守门与 --carry-verify ---

#[test]
fn archive_refuses_an_open_verify_ticket_with_three_disposals() {
    // spec Scenario「仅验证工单时拒绝」：stderr 同列 stamp／discard／--carry-verify。
    let p = TempProject::with_change("archive-gate", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let out = p.run(&["archive", "demo", "--skip-specs", "--no-validate"]);
    assert!(!out.status.success(), "open ticket must refuse archive");
    let err = stderr_of(&out);
    for needle in ["verify stamp", "verify discard", "--carry-verify"] {
        assert!(err.contains(needle), "missing {needle}: {err}");
    }
    assert!(p.ticket_path().exists(), "change stays in place");
}

#[test]
fn archive_lists_both_stations_when_both_tickets_are_open() {
    // spec Scenario「双工单并存」：两组处置并列。
    let p = TempProject::with_change("archive-both", TASKS_DONE);
    p.run_stdin(&["review", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let out = p.run(&["archive", "demo", "--skip-specs", "--no-validate"]);
    assert!(!out.status.success());
    let err = stderr_of(&out);
    for needle in ["--carry-review", "--carry-verify", "review stamp", "verify stamp"] {
        assert!(err.contains(needle), "missing {needle}: {err}");
    }
}

#[test]
fn archive_carry_verify_moves_the_ticket_into_the_archive() {
    // spec Scenario「明示带走验证工单」：封存成功且封存目录内含 verify.md。
    let p = TempProject::with_change("archive-carry", TASKS_DONE);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let out = p.run(&["archive", "demo", "--skip-specs", "--no-validate", "--carry-verify"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let archive_root = p.dir.join("specseal").join("changes").join("archive");
    let dated = std::fs::read_dir(&archive_root)
        .expect("archive dir")
        .next()
        .expect("one archived change")
        .unwrap()
        .path();
    assert!(dated.join("verify.md").is_file(), "fossil ticket travels: {dated:?}");
}

#[test]
fn archive_carries_both_tickets_when_both_flags_ride_along() {
    // spec「`--carry-review` 与 `--carry-verify` 可同时带」。
    let p = TempProject::with_change("archive-carry-both", TASKS_DONE);
    p.run_stdin(&["review", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let out = p.run(&[
        "archive",
        "demo",
        "--skip-specs",
        "--no-validate",
        "--carry-review",
        "--carry-verify",
    ]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let archive_root = p.dir.join("specseal").join("changes").join("archive");
    let dated =
        std::fs::read_dir(&archive_root).unwrap().next().unwrap().unwrap().path();
    assert!(dated.join("review.md").is_file(), "{dated:?}");
    assert!(dated.join("verify.md").is_file(), "{dated:?}");
}

// --- verify scope（design D8：共用 resolver、站别 snapshot namespace）---

fn scope_fixture(tag: &str) -> TempProject {
    let p = TempProject::with_change(tag, TASKS_DONE);
    let wide: String = (1..=20).map(|i| format!("line {i}\n")).collect();
    p.write("src/util.rs", &wide);
    p.git(&["init", "-q"]);
    p.git(&["config", "user.name", "Sandbox Tester"]);
    p.git(&["config", "user.email", "sandbox@example.com"]);
    p.git(&["add", "-A"]);
    p.git(&["commit", "-q", "-m", "init"]);
    // Apply baseline 由审查站的 prepare 创建，两站共用（design D8）。
    let prepared = p.run(&["review", "prepare", "demo"]);
    assert!(prepared.status.success(), "prepare: {}", stderr_of(&prepared));
    p.write("src/lib.rs", "fn demo() {}\nfn added() {}\n");
    let edited = wide
        .replace("line 2\n", "line 2 edited\n")
        .replace("line 18\n", "line 18 edited\n");
    p.write("src/util.rs", &edited);
    p.touched("demo", &["src/lib.rs", "src/util.rs"]);
    p
}

#[test]
fn verify_scope_discovery_json_payload_is_camel_case_with_hunk_ranges() {
    // spec Scenario「discovery scope 复用 Host resolver」：phase=discovery、
    // state=resolved、hunks 带 old/new ranges，verify-snapshots 添加对应档。
    let p = scope_fixture("scope-json");
    let out = p.run(&["verify", "scope", "demo", "--json"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid JSON");
    assert_eq!(v["change"], "demo");
    assert_eq!(v["phase"], "discovery");
    assert_eq!(v["state"], "resolved");
    assert_eq!(v["baseCommit"].as_str().map(str::len), Some(40), "{v}");
    assert!(v["candidateHash"].as_str().unwrap().starts_with("sha256:"), "{v}");
    assert!(v["patchHash"].as_str().unwrap().starts_with("sha256:"), "{v}");
    assert_eq!(v["paths"], serde_json::json!(["src/lib.rs", "src/util.rs"]));
    let files = v["files"].as_array().expect("files array");
    assert_eq!(files.len(), 2);
    for f in files {
        for h in f["hunks"].as_array().unwrap() {
            for k in ["oldStart", "oldLines", "newStart", "newLines"] {
                assert!(h[k].is_number(), "range {k} is a number: {h}");
            }
        }
    }
    assert_eq!(p.snapshot_count("verify-snapshots"), 1, "the verify snapshot is written");
    assert_eq!(p.snapshot_count("snapshots"), 0, "the review namespace stays empty");
}

#[test]
fn verify_scope_human_output_has_no_ansi_under_no_color() {
    let p = scope_fixture("scope-human");
    let out = p.run(&["--no-color", "verify", "scope", "demo"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    let text = stdout_of(&out);
    assert!(text.contains("discovery"), "{text}");
    assert!(text.contains("sha256:"), "{text}");
    assert!(!text.contains('\u{1b}'), "--no-color must strip ANSI: {text:?}");
}

#[test]
fn verify_scope_validation_only_freezes_the_remediation_patch() {
    // spec Scenario「validation 只冻结修正 patch」：两档 discovery 后只改一档，
    // 续轮 phase=validation 且 patch 不含未修改的另一档。
    let p = scope_fixture("scope-validation");
    let first = p.run(&["verify", "scope", "demo", "--json"]);
    assert!(first.status.success(), "stderr: {}", stderr_of(&first));
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&first)).unwrap();
    let patch_hash = v["patchHash"].as_str().unwrap().to_string();
    let round = format!(
        "**Phase**: discovery\n**Patch**: {patch_hash}\n**Scope**: src/lib.rs, src/util.rs\n\n\
         - [CRITICAL] src/lib.rs — requirement R2 has no implementation\n"
    );
    let added = p.run_stdin(&["verify", "add-round", "demo", "--stdin"], &round);
    assert!(added.status.success(), "stderr: {}", stderr_of(&added));

    p.write("src/lib.rs", "fn demo() {}\nfn added() {}\nfn fixed() {}\n");
    let second = p.run(&["verify", "scope", "demo", "--json"]);
    assert!(second.status.success(), "stderr: {}", stderr_of(&second));
    let v2: serde_json::Value = serde_json::from_str(&stdout_of(&second)).unwrap();
    assert_eq!(v2["phase"], "validation");
    assert_eq!(v2["paths"], serde_json::json!(["src/lib.rs"]), "only the fixed file: {v2}");
    assert!(v2["patch"].as_str().unwrap().contains("+fn fixed() {}"), "{v2}");
    assert!(!v2["patch"].as_str().unwrap().contains("line 2 edited"), "{v2}");
}

#[test]
fn verify_scope_missing_snapshot_fails_closed_without_falling_back() {
    // spec Scenario「snapshot 缺失不退回 discovery」：referenced snapshot 被移除 →
    // 非零、工单不变、不得用 touched 整档创建新 discovery snapshot。
    let p = scope_fixture("scope-nosnap");
    let first = p.run(&["verify", "scope", "demo", "--json"]);
    assert!(first.status.success(), "stderr: {}", stderr_of(&first));
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&first)).unwrap();
    let patch_hash = v["patchHash"].as_str().unwrap().to_string();
    let round = format!(
        "**Phase**: discovery\n**Patch**: {patch_hash}\n**Scope**: src/lib.rs\n\n\
         - [CRITICAL] src/lib.rs — requirement R2 has no implementation\n"
    );
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], &round);
    let ticket_before = std::fs::read_to_string(p.ticket_path()).unwrap();
    std::fs::remove_dir_all(p.scope_dir().join("verify-snapshots")).unwrap();

    let out = p.run(&["verify", "scope", "demo", "--json"]);
    assert!(!out.status.success(), "missing snapshot must fail closed");
    assert_eq!(p.snapshot_count("verify-snapshots"), 0, "no snapshot may be written");
    assert_eq!(std::fs::read_to_string(p.ticket_path()).unwrap(), ticket_before, "ticket intact");
}

#[test]
fn verify_scope_needs_input_when_the_baseline_is_missing() {
    // spec：baseline 缺失 → JSON 路径印 state=needsInput 后非零，零 snapshot 效果，
    // stderr 列可用处置。payload shape 与 `review scope` 同构。
    let p = TempProject::with_git_change("scope-nobaseline", TASKS_DONE);
    p.write("src/lib.rs", "fn demo() {}\nfn added() {}\n");
    p.touched("demo", &["src/lib.rs"]);
    let out = p.run(&["verify", "scope", "demo", "--json"]);
    assert!(!out.status.success(), "ambiguous scope must be non-zero");
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid JSON");
    assert_eq!(v["state"], "needsInput");
    assert_eq!(v["phase"], "discovery");
    assert!(v["ambiguousPaths"].is_array(), "{v}");
    assert!(v["files"].is_array(), "{v}");
    let err = stderr_of(&out);
    assert!(err.contains("verify scope for 'demo' needs input"), "station-worded: {err}");
    assert!(err.contains("--base"), "disposal named: {err}");
    assert_eq!(p.snapshot_count("verify-snapshots"), 0, "zero snapshot effects");
}

#[test]
fn verify_scope_dirty_at_start_and_active_overlap_fail_closed() {
    // spec：dirty-at-start 与其他 active change 的 touched 认领重叠 → needsInput。
    let dirty = scope_fixture("scope-dirty");
    // baseline 已记录干净起点；把 touched 档声明为起始即脏需要重录 baseline，
    // 故改以另一个 active change 认领同一路径触发 overlap。
    let other = dirty.dir.join("specseal").join("changes").join("other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join(".meta.yaml"), "schema: spec-driven\ncreated: 2026-07-01\n")
        .unwrap();
    std::fs::write(other.join("tasks.md"), "- [ ] 1.1 x\n").unwrap();
    dirty.touched("other", &["src/lib.rs"]);
    let out = dirty.run(&["verify", "scope", "demo", "--json"]);
    assert!(!out.status.success(), "overlapping claim must fail closed");
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid JSON");
    assert_eq!(v["state"], "needsInput");
    assert!(stderr_of(&out).contains("other"), "names the claiming change: {}", stderr_of(&out));
    assert_eq!(dirty.snapshot_count("verify-snapshots"), 0, "zero snapshot effects");
}

#[test]
fn verify_scope_hash_pinned_selection_rejects_candidate_drift() {
    // spec：hash-pinned selection 必须带正确的 candidate hash，漂移即拒；
    // 选定 hunk 后只冻结所选文本段。
    let p = scope_fixture("scope-pinned");
    let probe = p.run(&["verify", "scope", "demo", "--json"]);
    assert!(probe.status.success(), "stderr: {}", stderr_of(&probe));
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&probe)).unwrap();
    let candidate = v["candidateHash"].as_str().unwrap().to_string();
    let hunk = v["files"][0]["hunks"][0]["id"].as_str().unwrap().to_string();

    let stale = format!("sha256:{}", "0".repeat(64));
    let drifted = p.run(&[
        "verify",
        "scope",
        "demo",
        "--json",
        "--candidate-hash",
        &stale,
        "--include-hunk",
        &hunk,
    ]);
    assert!(!drifted.status.success(), "a stale candidate hash must be rejected");

    let pinned = p.run(&[
        "verify",
        "scope",
        "demo",
        "--json",
        "--candidate-hash",
        &candidate,
        "--include-hunk",
        &hunk,
    ]);
    assert!(pinned.status.success(), "stderr: {}", stderr_of(&pinned));
    let v2: serde_json::Value = serde_json::from_str(&stdout_of(&pinned)).unwrap();
    assert_eq!(v2["state"], "resolved");
    assert_ne!(v2["patchHash"], v2["candidateHash"], "a narrowed selection re-hashes: {v2}");
}

#[test]
fn verify_scope_rejects_include_hunk_without_a_candidate_hash() {
    // audit（sharp edges）：选择参数缺锚即拒，不得静默改跑全候选。
    let p = scope_fixture("scope-flagguard");
    let out = p.run(&["verify", "scope", "demo", "--json", "--include-hunk", "h1"]);
    assert!(!out.status.success(), "selection without an anchor must fail loudly");
}

// --- 两站 snapshot cleanup 隔离（design D8）---

#[test]
fn verify_stamp_clears_only_verify_snapshots() {
    // spec Scenario「两站 snapshot 清理互不影响」：verify stamp 只清 verify
    // snapshots，Apply baseline 与 review snapshots 比特级不变。
    let p = TempProject::with_git_change("cleanup-stamp", TASKS_DONE);
    assert!(p.run(&["review", "prepare", "demo"]).status.success());
    let review_dir = p.scope_dir().join("snapshots");
    let verify_dir = p.scope_dir().join("verify-snapshots");
    std::fs::create_dir_all(&review_dir).unwrap();
    std::fs::create_dir_all(&verify_dir).unwrap();
    std::fs::write(review_dir.join(format!("{}.json", "a".repeat(64))), "{\"r\":1}").unwrap();
    std::fs::write(verify_dir.join(format!("{}.json", "b".repeat(64))), "{\"v\":1}").unwrap();
    let baseline_before = std::fs::read_to_string(p.baseline_path()).unwrap();

    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], CLEAN_ROUND);
    let out = p.run(&["verify", "stamp", "demo"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(p.snapshot_count("verify-snapshots"), 0, "verify snapshots cleared");
    assert_eq!(p.snapshot_count("snapshots"), 1, "review snapshots untouched");
    assert_eq!(std::fs::read_to_string(p.baseline_path()).unwrap(), baseline_before);
}

#[test]
fn review_stamp_leaves_verify_snapshots_alone() {
    // 反向：审查站清理不得带走验证站的续轮依据。
    let p = TempProject::with_git_change("cleanup-review", TASKS_DONE);
    assert!(p.run(&["review", "prepare", "demo"]).status.success());
    let review_dir = p.scope_dir().join("snapshots");
    let verify_dir = p.scope_dir().join("verify-snapshots");
    std::fs::create_dir_all(&review_dir).unwrap();
    std::fs::create_dir_all(&verify_dir).unwrap();
    std::fs::write(review_dir.join(format!("{}.json", "a".repeat(64))), "{\"r\":1}").unwrap();
    std::fs::write(verify_dir.join(format!("{}.json", "b".repeat(64))), "{\"v\":1}").unwrap();

    p.run_stdin(&["review", "add-round", "demo", "--stdin"], CLEAN_ROUND);
    let out = p.run(&["review", "stamp", "demo"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(p.snapshot_count("snapshots"), 0, "review snapshots cleared");
    assert_eq!(p.snapshot_count("verify-snapshots"), 1, "verify snapshots untouched");
}

#[test]
fn verify_discard_clears_only_verify_snapshots_and_keeps_the_review_ticket() {
    // spec「`verify discard` 只清除 verify snapshots」＋两站工单互不屏蔽。
    let p = TempProject::with_git_change("cleanup-discard", TASKS_DONE);
    assert!(p.run(&["review", "prepare", "demo"]).status.success());
    let review_dir = p.scope_dir().join("snapshots");
    let verify_dir = p.scope_dir().join("verify-snapshots");
    std::fs::create_dir_all(&review_dir).unwrap();
    std::fs::create_dir_all(&verify_dir).unwrap();
    std::fs::write(review_dir.join(format!("{}.json", "a".repeat(64))), "{\"r\":1}").unwrap();
    std::fs::write(verify_dir.join(format!("{}.json", "b".repeat(64))), "{\"v\":1}").unwrap();

    p.run_stdin(&["review", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    p.run_stdin(&["verify", "add-round", "demo", "--stdin"], ROUND_WITH_FINDINGS);
    let out = p.run(&["verify", "discard", "demo"]);
    assert!(out.status.success(), "stderr: {}", stderr_of(&out));
    assert_eq!(p.snapshot_count("verify-snapshots"), 0, "verify snapshots cleared");
    assert_eq!(p.snapshot_count("snapshots"), 1, "review snapshots untouched");
    assert!(p.baseline_path().exists(), "Apply baseline survives");
    assert!(p.review_ticket_path().exists(), "the review ticket survives");
}
