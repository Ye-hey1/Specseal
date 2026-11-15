//! Integration tests: change metadata time fields are written as RFC 3339 stamps,
//! but every output keeps emitting the date part (spec change-lifecycle「change
//! metadata 时间字段写入时戳、对外输出日期」; process-cost-metrics design D2).

use std::path::PathBuf;
use std::process::{Command, Output};

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// Project skeleton with one change named `name` carrying `meta`.
    fn new(tag: &str, name: &str, meta: &str) -> TempProject {
        let dir = std::env::temp_dir().join(format!(
            "specseal-cli-meta-time-stamps-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("specseal").join("specs")).unwrap();
        std::fs::write(dir.join(".specseal.yaml"), "tools:\n  - claude\n").unwrap();
        let change = dir.join("specseal").join("changes").join(name);
        std::fs::create_dir_all(&change).unwrap();
        std::fs::write(change.join(".meta.yaml"), meta).unwrap();
        std::fs::write(change.join("proposal.md"), "## Why\n\nDemo.\n").unwrap();
        std::fs::write(change.join("tasks.md"), "- [ ] 1.1 Do the thing\n").unwrap();
        TempProject { dir }
    }

    fn run(&self, args: &[&str]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_specseal"));
        cmd.args(args).current_dir(&self.dir);
        for key in [
            "SPECSEAL_LOCALE",
            "SPECSEAL_SPEC_LOCALE",
            "SPECSEAL_TDD",
            "SPECSEAL_AUDIT",
            "SPECSEAL_STORE_URL",
        ] {
            cmd.env_remove(key);
        }
        cmd.output().expect("run specseal binary")
    }

    fn json(&self, args: &[&str]) -> serde_json::Value {
        let out = self.run(args);
        assert!(out.status.success(), "{args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice(&out.stdout).expect("stdout is JSON")
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn show_outputs_only_the_date_part_of_a_stamped_created() {
    // spec scenario「对外输出只给日期部分」。
    let p = TempProject::new(
        "show",
        "demo",
        "schema: spec-driven\ncreated: 2026-10-21T14:05:00+08:00\n",
    );
    let out = p.run(&["show", "demo"]);
    assert!(out.status.success(), "show failed: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.lines().any(|l| l == "Created: 2026-10-21"),
        "human output carries the date part only: {stdout}"
    );
    let json = p.json(&["show", "demo", "--json"]);
    assert_eq!(json["created"], "2026-10-21");
}

#[test]
fn plain_date_created_keeps_the_existing_outputs() {
    // spec scenario「纯日期记录的输出不变」：show --json 与 list --json 与本变更之前
    // 的输出相同，没有警告。
    let p = TempProject::new("plain", "demo", "schema: spec-driven\ncreated: 2026-07-29\n");
    let show = p.run(&["show", "demo", "--json"]);
    assert!(show.status.success() && show.stderr.is_empty(), "{}", String::from_utf8_lossy(&show.stderr));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&show.stdout).unwrap(),
        serde_json::json!({
            "created": "2026-07-29",
            "deltaSpecs": [],
            "design": null,
            "fromDiscussions": [],
            "name": "demo",
            "proposal": "## Why\n\nDemo.\n",
            "restaleFrom": [],
            "schema": "spec-driven",
            "tasks": "- [ ] 1.1 Do the thing\n"
        })
    );
    let list = p.run(&["list", "--json"]);
    assert!(list.status.success() && list.stderr.is_empty(), "{}", String::from_utf8_lossy(&list.stderr));
    // `modifiedAt` is the store's clock, so it is checked for its shape and
    // then left out of the exact comparison.
    let mut listed = serde_json::from_slice::<serde_json::Value>(&list.stdout).unwrap();
    let modified_at = listed["changes"][0].as_object_mut().unwrap().remove("modifiedAt");
    assert!(modified_at.is_some_and(|at| at.is_string()), "the fs store dates the change");
    assert_eq!(
        listed,
        serde_json::json!({ "changes": [{
            "completedTasks": 0,
            "created": "2026-07-29",
            "name": "demo",
            "status": "in-progress",
            "summary": "Demo.",
            "totalTasks": 1
        }] })
    );
}

#[test]
fn new_change_writes_created_as_an_rfc3339_stamp() {
    // spec scenario「新变更写入时戳」：经 CLI 创建的 change，档内 created 是 RFC 3339。
    let p = TempProject::new("new", "existing", "schema: spec-driven\ncreated: 2026-07-29\n");
    let out = p.run(&["new", "change", "fresh"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let meta = std::fs::read_to_string(
        p.dir.join("specseal").join("changes").join("fresh").join(".meta.yaml"),
    )
    .unwrap();
    let created = meta.lines().find_map(|l| l.strip_prefix("created: ")).expect("created line");
    assert!(
        created.len() == 25 && chrono::DateTime::parse_from_rfc3339(created).is_ok(),
        "created is an offset stamp at second precision: {meta}"
    );
}

#[test]
fn staleness_of_a_stamped_created_counts_from_its_date_part() {
    // 依创建日期计算的天数取日期部分：时戳不会让过期判定解析失败。
    let p = TempProject::new(
        "stale",
        "demo",
        "schema: spec-driven\ncreated: 2026-09-01T23:30:00-05:00\n",
    );
    // 指令前后各取一次「今天」：跑在午夜两侧时两个天数都算对。
    let created = chrono::NaiveDate::from_ymd_opt(2026, 9, 1).unwrap();
    let days_old = || (chrono::Local::now().date_naive() - created).num_days();
    let before = days_old();
    let json = p.json(&["instructions", "apply", "--change", "demo", "--json"]);
    let after = days_old();
    let actual = json["preflight"]["staleness"]["daysOld"].as_i64();
    assert!(actual == Some(before) || actual == Some(after), "preflight: {json}");
}

#[test]
fn unrecognised_created_is_output_verbatim_without_staleness() {
    // spec scenario「无法辨识的时间值维持现行行为」。
    let p = TempProject::new("odd", "odd", "schema: spec-driven\ncreated: someday\n");
    let out = p.run(&["show", "odd"]);
    assert!(out.status.success(), "show failed: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.lines().any(|l| l == "Created: someday"), "verbatim value: {stdout}");
    let json = p.json(&["instructions", "apply", "--change", "odd", "--json"]);
    assert!(
        json["preflight"].get("staleness").is_none(),
        "no staleness for an unrecognised created: {json}"
    );
}
