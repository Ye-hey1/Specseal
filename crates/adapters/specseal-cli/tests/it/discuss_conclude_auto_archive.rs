//! Integration coverage for the conclude closing step (conclusion-gated-discussion-archive):
//! concluding a spun-out discussion whose changes have all left the in-flight set
//! auto-archives the record and reports it; the ordinary conclude output stays
//! byte-identical to the pre-change baseline.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

struct TempProject {
    dir: PathBuf,
}

impl TempProject {
    /// A project holding one live discussion written from `doc`.
    fn with_discussion(tag: &str, slug: &str, doc: &str) -> TempProject {
        let dir = std::env::temp_dir()
            .join(format!("specseal-cli-conclude-auto-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let discussions = dir.join("specseal").join("discussions");
        std::fs::create_dir_all(&discussions).unwrap();
        std::fs::create_dir_all(dir.join("specseal").join("changes")).unwrap();
        std::fs::write(discussions.join(format!("{slug}.md")), doc).unwrap();
        TempProject { dir }
    }

    fn run_stdin(&self, args: &[&str], input: &str) -> Output {
        let mut c = Command::new(env!("CARGO_BIN_EXE_specseal"));
        c.args(args)
            .current_dir(&self.dir)
            .env_remove("NO_COLOR")
            .env_remove("CLICOLOR")
            .env_remove("CLICOLOR_FORCE")
            .env_remove("SPECSEAL_STORE_URL")
            .env_remove("SPECSEAL_TOKEN");
        let mut child = c
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn specseal binary");
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        child.wait_with_output().expect("wait specseal binary")
    }

    /// Run without piping stdin (verbs that take no `--stdin`).
    fn run(&self, args: &[&str]) -> Output {
        self.run_stdin(args, "")
    }

    /// An in-flight change whose `from_discussion` points at `slug`, with every
    /// task done so the archive completeness gate passes.
    fn put_change(&self, name: &str, slug: &str) {
        let dir = self.dir.join("specseal").join("changes").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".meta.yaml"),
            format!("schema: spec-driven\ncreated: 2026-01-02\nfrom_discussion: {slug}\n"),
        )
        .unwrap();
        self.finish_tasks(name);
    }

    /// 在途记录的全文。
    fn discussion(&self, slug: &str) -> String {
        std::fs::read_to_string(
            self.dir.join("specseal").join("discussions").join(format!("{slug}.md")),
        )
        .unwrap()
    }

    /// 让 `name` 通过封存的完整度守门（promote 建出的骨架没有已完成任务）。
    fn finish_tasks(&self, name: &str) {
        std::fs::write(
            self.dir.join("specseal").join("changes").join(name).join("tasks.md"),
            "- [x] 1.1 done\n",
        )
        .unwrap();
    }

    fn live_exists(&self, slug: &str) -> bool {
        self.dir.join("specseal").join("discussions").join(format!("{slug}.md")).exists()
    }

    fn archived_exists(&self, slug: &str) -> bool {
        let archive = self.dir.join("specseal").join("discussions").join("archive");
        std::fs::read_dir(&archive)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().ends_with(&format!("-{slug}.md")))
            })
            .unwrap_or(false)
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

fn ok(out: &Output) {
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
}

/// A promoted discussion whose only spun-out change is no longer in flight
/// (archived), and whose conclusion is still the scaffold placeholder.
fn promoted_unconcluded_doc(slug: &str) -> String {
    format!(
        "---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\npromoted_to: cut-a\ncreated: 2026-01-02\n---\n\n\
         # Discussion: {slug}\n\n## Context\n\nFixture.\n\n## Rounds\n\n\
         ## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n"
    )
}

/// A plain open discussion (never spun out).
fn open_doc(slug: &str) -> String {
    format!(
        "---\ntopic: {slug}\nslug: {slug}\nstatus: open\ncreated: 2026-01-02\n---\n\n\
         # Discussion: {slug}\n\n## Context\n\nFixture.\n\n## Rounds\n\n\
         ## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n"
    )
}

#[test]
fn conclude_auto_archives_and_reports_in_human_output() {
    let p = TempProject::with_discussion("human", "alpha", &promoted_unconcluded_doc("alpha"));

    let out = p.run_stdin(&["discuss", "conclude", "alpha", "--stdin"], "**Decision**: done\n");
    ok(&out);

    let text = stdout_of(&out);
    assert!(text.contains("Concluded discussion 'alpha'"), "stdout: {text}");
    assert!(
        text.to_lowercase().contains("archived"),
        "closing step must be announced: {text}"
    );
    assert!(!p.live_exists("alpha"), "record leaves specseal/discussions/");
    assert!(p.archived_exists("alpha"), "record lands in discussions/archive/");
}

#[test]
fn conclude_auto_archive_json_carries_auto_archived_true() {
    let p = TempProject::with_discussion("json", "alpha", &promoted_unconcluded_doc("alpha"));

    let out = p.run_stdin(
        &["discuss", "conclude", "alpha", "--stdin", "--json"],
        "**Decision**: done\n",
    );
    ok(&out);

    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid json");
    assert_eq!(v["status"], "concluded");
    assert_eq!(v["autoArchived"], serde_json::json!(true));
    assert!(p.archived_exists("alpha"));
}

#[test]
fn ordinary_conclude_output_stays_byte_identical() {
    // 未触发闭环（promoted_to 缺席）→ 人眼与 --json 皆维持既有基线：无多行、无新键。
    let p = TempProject::with_discussion("base-h", "alpha", &open_doc("alpha"));
    let out = p.run_stdin(&["discuss", "conclude", "alpha", "--stdin"], "**Decision**: done\n");
    ok(&out);
    let text = stdout_of(&out);
    assert_eq!(text.lines().count(), 1, "exactly the existing single line: {text}");
    assert!(text.contains("Concluded discussion 'alpha'"));
    assert!(p.live_exists("alpha"), "record stays live");

    let p2 = TempProject::with_discussion("base-j", "beta", &open_doc("beta"));
    let out2 =
        p2.run_stdin(&["discuss", "conclude", "beta", "--stdin", "--json"], "**Decision**: done\n");
    ok(&out2);
    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out2)).expect("valid json");
    assert!(v.get("autoArchived").is_none(), "no new key on the ordinary path: {v}");
    assert!(v.get("held").is_none(), "no held key without --hold: {v}");
    assert_eq!(v["status"], "concluded");
}

// --- --hold（discussion-spinout-hold）---

#[test]
fn conclude_with_hold_keeps_the_record_live_and_reports_it() {
    // 闭环条件成立、但带 --hold → 记录留在途，人眼多一行保留消息、无 Auto-archived 行。
    let p = TempProject::with_discussion("hold-h", "alpha", &promoted_unconcluded_doc("alpha"));

    let out = p.run_stdin(
        &["discuss", "conclude", "alpha", "--stdin", "--hold"],
        "**Decision**: cut-b later\n",
    );
    ok(&out);

    let text = stdout_of(&out);
    assert!(text.contains("Concluded discussion 'alpha'"), "stdout: {text}");
    assert!(text.contains("Held live (a later spin-out is planned)"), "stdout: {text}");
    assert!(!text.contains("Auto-archived"), "闭环不触发: {text}");
    assert!(p.live_exists("alpha"), "record stays in specseal/discussions/");
    assert!(!p.archived_exists("alpha"));

    let doc = std::fs::read_to_string(
        p.dir.join("specseal").join("discussions").join("alpha.md"),
    )
    .unwrap();
    assert!(doc.contains("hold: true"), "frontmatter carries the flag: {doc}");
    assert!(doc.contains("**Decision**: cut-b later"), "conclusion landed in the same write");
}

#[test]
fn conclude_with_hold_json_carries_held_true_without_auto_archived() {
    let p = TempProject::with_discussion("hold-j", "alpha", &promoted_unconcluded_doc("alpha"));

    let out = p.run_stdin(
        &["discuss", "conclude", "alpha", "--stdin", "--json", "--hold"],
        "**Decision**: cut-b later\n",
    );
    ok(&out);

    let v: serde_json::Value = serde_json::from_str(&stdout_of(&out)).expect("valid json");
    assert_eq!(v["status"], "concluded");
    assert_eq!(v["held"], serde_json::json!(true));
    assert!(v.get("autoArchived").is_none(), "闭环未触发，无此键: {v}");
    assert!(p.live_exists("alpha"));
}

#[test]
fn staged_spin_out_lifecycle_releases_on_the_last_cut_and_archives_itself() {
    // 规格 Example「分期三刀的生命周期」：alpha 尚未转出任何变更，以 --hold 结论
    // 一次后依序转出并封存三刀——前两刀不带旗标，封存后记录留在途、封存输出不列它；
    // 第三刀 promote 带 --last 解除旗标，封存它时记录随行封存，全程不跑 discuss archive。
    let p = TempProject::with_discussion("lifecycle", "alpha", &open_doc("alpha"));

    let out = p.run_stdin(
        &["discuss", "conclude", "alpha", "--stdin", "--hold"],
        "**Decision**: three cuts in order\n",
    );
    ok(&out);
    assert!(p.live_exists("alpha"), "带 hold 的结论不封存记录");

    let mut accumulated = String::new();
    for cut in ["cut-a", "cut-b", "cut-c"] {
        let is_last = cut == "cut-c";
        let mut args = vec!["discuss", "promote", "alpha", "--name", cut];
        if is_last {
            args.push("--last");
        }
        ok(&p.run(&args));
        if !accumulated.is_empty() {
            accumulated.push_str(", ");
        }
        accumulated.push_str(cut);
        let doc = p.discussion("alpha");
        assert!(doc.contains(&format!("promoted_to: {accumulated}\n")), "依序累加: {doc}");
        assert_eq!(
            doc.contains("hold: true"),
            !is_last,
            "旗标在最后一刀转出前保留、转出时解除（{cut}）: {doc}"
        );

        p.finish_tasks(cut);
        let out = p.run(&["archive", cut, "--yes", "--skip-specs"]);
        ok(&out);
        let text = stdout_of(&out);
        if is_last {
            assert!(text.contains("Discussion archived: alpha"), "最后一个封存列它: {text}");
            assert!(!p.live_exists("alpha"), "最后一刀封存后记录离开在途");
            assert!(p.archived_exists("alpha"));
        } else {
            assert!(!text.contains("alpha"), "随行封存清单不列带 hold 的讨论: {text}");
            assert!(p.live_exists("alpha"), "{cut} 封存后记录仍在途");
            assert!(!p.archived_exists("alpha"));
        }
    }
}

/// 带 `hold: true` 的已结论已转出讨论——分期系列在途、下一刀还没创建。
fn held_doc(slug: &str) -> String {
    format!(
        "---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\npromoted_to: cut-a\ncreated: 2026-01-02\nhold: true\n---\n\n\
         # Discussion: {slug}\n\n## Context\n\nFixture.\n\n## Rounds\n\n\
         ## Conclusion\n\n**Decision**: cut-a now, cut-b next\n"
    )
}

/// stdout，把项目自身的目录换成占位符（人眼路径、JSON 的斜线路径、JSON 逃脱过的
/// 反斜线路径三种写法都换），只差 hold 行的两个项目才好逐比特比对。
fn normalized_stdout(p: &TempProject, out: &Output) -> String {
    let raw = p.dir.to_string_lossy().to_string();
    stdout_of(out)
        .replace(&raw.replace('\\', "\\\\"), "<DIR>")
        .replace(&raw, "<DIR>")
        .replace(&raw.replace('\\', "/"), "<DIR>")
}

/// 对「只差一行 hold」的两份相同记录跑同一组指令，断言输出逐比特相同（转出动词
/// 从不报告 hold），回传带旗标那份的范式 stdout 与转出后的记录全文。
fn held_vs_plain(
    tag: &str,
    slug: &str,
    run_it: impl Fn(&TempProject) -> Output,
) -> (String, String) {
    let held = TempProject::with_discussion(&format!("{tag}-held"), slug, &held_doc(slug));
    let plain = TempProject::with_discussion(
        &format!("{tag}-plain"),
        slug,
        &held_doc(slug).replace("hold: true\n", ""),
    );
    let held_out = run_it(&held);
    let plain_out = run_it(&plain);
    ok(&held_out);
    ok(&plain_out);
    let shown = normalized_stdout(&held, &held_out);
    assert_eq!(shown, normalized_stdout(&plain, &plain_out), "旗标不改变输出");
    (shown, held.discussion(slug))
}

/// 转出后的记录：promoted_to 累加了 cut-b、status 为 promoted、旗标逐字保留；
/// 输出（人眼或 --json）不提 hold。
fn assert_spun_out_and_still_held(shown: &str, doc: &str) {
    assert!(doc.contains("promoted_to: cut-a, cut-b\n"), "promoted_to 累加: {doc}");
    assert!(doc.contains("status: promoted"), "status 为 promoted: {doc}");
    assert!(doc.contains("hold: true"), "旗标逐字保留: {doc}");
    assert!(!shown.contains("hold"), "输出不提旗标: {shown}");
}

/// 第三条转出路径：先 link 到既有变更（记录逐比特不变），再 seal 补标。
fn link_then_seal(p: &TempProject, extra: &[&str]) -> Output {
    p.put_change("cut-b", "gamma");
    let before = p.discussion("gamma");
    ok(&p.run(&["discuss", "link", "gamma", "cut-b"]));
    assert_eq!(p.discussion("gamma"), before, "link 当下记录逐比特不变");
    let mut args = vec!["discuss", "seal", "gamma", "cut-b"];
    args.extend_from_slice(extra);
    p.run(&args)
}

#[test]
fn spin_out_paths_keep_the_hold_flag_and_leave_human_output_unchanged() {
    // 规格「转出保留旗标」：三个转出路径（discuss promote、new change
    // --from-discussion、discuss seal）对带 hold 的记录都累加 promoted_to 且旗标
    // 逐字保留；人眼输出与不带旗标时逐比特相同。
    let (shown, doc) = held_vs_plain("promote-human", "alpha", |p| {
        p.run(&["discuss", "promote", "alpha", "--name", "cut-b"])
    });
    assert_spun_out_and_still_held(&shown, &doc);

    let (shown, doc) = held_vs_plain("newchange-human", "beta", |p| {
        p.run(&["new", "change", "cut-b", "--from-discussion", "beta"])
    });
    assert_spun_out_and_still_held(&shown, &doc);

    let (shown, doc) = held_vs_plain("seal-human", "gamma", |p| link_then_seal(p, &[]));
    assert_spun_out_and_still_held(&shown, &doc);
}

#[test]
fn spin_out_paths_keep_the_hold_flag_and_leave_json_output_unchanged() {
    // 同上，--json 那一面（`new change` 没有 --json 旗标，只有两条路径）。
    let (shown, doc) = held_vs_plain("promote-json", "alpha", |p| {
        p.run(&["discuss", "promote", "alpha", "--name", "cut-b", "--json"])
    });
    assert_spun_out_and_still_held(&shown, &doc);

    let (shown, doc) = held_vs_plain("seal-json", "gamma", |p| link_then_seal(p, &["--json"]));
    assert_spun_out_and_still_held(&shown, &doc);
}

/// 对「同一份带 hold 的记录」跑同一组指令、一次带 --last 一次不带，断言输出逐比特
/// 相同（旗标从不进输出），回传带 --last 那份转出后的记录全文。
fn last_vs_plain(tag: &str, slug: &str, run_it: impl Fn(&TempProject, &[&str]) -> Output) -> String {
    let with_last = TempProject::with_discussion(&format!("{tag}-last"), slug, &held_doc(slug));
    let without = TempProject::with_discussion(&format!("{tag}-nolast"), slug, &held_doc(slug));
    let last_out = run_it(&with_last, &["--last"]);
    let plain_out = run_it(&without, &[]);
    ok(&last_out);
    ok(&plain_out);
    assert_eq!(
        normalized_stdout(&with_last, &last_out),
        normalized_stdout(&without, &plain_out),
        "--last 不改变输出"
    );
    assert!(without.discussion(slug).contains("hold: true"), "不带 --last 的对照组仍保留旗标");
    with_last.discussion(slug)
}

/// 带 --last 转出后的记录：promoted_to 累加了 cut-b、status 为 promoted、hold 行消失。
fn assert_spun_out_and_released(doc: &str) {
    assert!(doc.contains("promoted_to: cut-a, cut-b\n"), "promoted_to 累加: {doc}");
    assert!(doc.contains("status: promoted"), "status 为 promoted: {doc}");
    assert!(!doc.contains("hold"), "hold 行整行消失: {doc}");
}

#[test]
fn spin_out_paths_with_last_drop_the_hold_and_leave_human_output_unchanged() {
    // 规格「带 --last 的转出解除旗标」：三个转出路径带 --last 都在累加 promoted_to 的
    // 同一次写入移除 hold 行；人眼输出与不带旗标时逐比特相同。
    let doc = last_vs_plain("promote-last-human", "alpha", |p, extra| {
        let mut args = vec!["discuss", "promote", "alpha", "--name", "cut-b"];
        args.extend_from_slice(extra);
        p.run(&args)
    });
    assert_spun_out_and_released(&doc);

    let doc = last_vs_plain("newchange-last-human", "beta", |p, extra| {
        let mut args = vec!["new", "change", "cut-b", "--from-discussion", "beta"];
        args.extend_from_slice(extra);
        p.run(&args)
    });
    assert_spun_out_and_released(&doc);

    let doc = last_vs_plain("seal-last-human", "gamma", |p, extra| link_then_seal(p, extra));
    assert_spun_out_and_released(&doc);
}

#[test]
fn spin_out_paths_with_last_drop_the_hold_and_leave_json_output_unchanged() {
    // 同上，--json 那一面（`new change` 没有 --json 旗标，只有两条路径）。
    let doc = last_vs_plain("promote-last-json", "alpha", |p, extra| {
        let mut args = vec!["discuss", "promote", "alpha", "--name", "cut-b", "--json"];
        args.extend_from_slice(extra);
        p.run(&args)
    });
    assert_spun_out_and_released(&doc);

    let doc = last_vs_plain("seal-last-json", "gamma", |p, extra| {
        let mut args = vec!["--json"];
        args.extend_from_slice(extra);
        link_then_seal(p, &args)
    });
    assert_spun_out_and_released(&doc);
}

#[test]
fn promote_with_last_on_a_record_without_hold_matches_the_plain_promote() {
    // 规格「带 --last 的转出解除旗标」第四段：无 hold 行的记录带 --last 是无害的
    // 无操作——记录与输出都与不带旗标的转出逐比特相同。
    let with_last = TempProject::with_discussion("nohold-last", "alpha", &open_doc("alpha"));
    let plain = TempProject::with_discussion("nohold-plain", "alpha", &open_doc("alpha"));

    let last_out = with_last.run(&["discuss", "promote", "alpha", "--name", "cut-a", "--last"]);
    let plain_out = plain.run(&["discuss", "promote", "alpha", "--name", "cut-a"]);
    ok(&last_out);
    ok(&plain_out);

    assert_eq!(with_last.discussion("alpha"), plain.discussion("alpha"), "记录逐比特相同");
    assert!(with_last.discussion("alpha").contains("promoted_to: cut-a\n"), "promoted_to 照常累加");
    assert_eq!(
        normalized_stdout(&with_last, &last_out),
        normalized_stdout(&plain, &plain_out),
        "输出逐比特相同"
    );
}

#[test]
fn seal_with_last_on_a_listed_change_drops_the_hold_without_touching_promoted_to() {
    // 规格「已在清单的名字带 --last 仍解除旗标」：忘了在立最后一刀时带旗标，对已在
    // promoted_to 的变更重跑 seal --last 就是不经 conclude 的补救路。
    let p = TempProject::with_discussion("seal-listed-last", "alpha", &held_doc("alpha"));
    p.put_change("cut-a", "alpha");
    let before = p.discussion("alpha");
    let plain = TempProject::with_discussion("seal-listed-plain", "alpha", &held_doc("alpha"));
    plain.put_change("cut-a", "alpha");

    let out = p.run(&["discuss", "seal", "alpha", "cut-a", "--last"]);
    ok(&out);
    let plain_out = plain.run(&["discuss", "seal", "alpha", "cut-a"]);
    ok(&plain_out);

    let doc = p.discussion("alpha");
    assert_eq!(doc, before.replace("hold: true\n", ""), "promoted_to 不变、只少 hold 行");
    assert_eq!(
        normalized_stdout(&p, &out),
        normalized_stdout(&plain, &plain_out),
        "--last 的 seal 输出与不带旗标时逐比特一致"
    );
    assert!(plain.discussion("alpha").contains("hold: true"), "不带 --last 的对照组仍保留旗标");

    let out = p.run(&["archive", "cut-a", "--yes", "--skip-specs"]);
    ok(&out);
    assert!(stdout_of(&out).contains("Discussion archived: alpha"), "其后封存 cut-a 随行封存记录");
    assert!(!p.live_exists("alpha"));
    assert!(p.archived_exists("alpha"));
}

#[test]
fn new_change_last_without_from_discussion_is_a_usage_error_that_writes_nothing() {
    // 规格「new change 的 --last 缺 --from-discussion 被拒」：clap 层拒绝（exit code 2），
    // stderr 说明相依，变更目录不存在、讨论记录逐比特不变。
    let p = TempProject::with_discussion("newchange-last-alone", "alpha", &held_doc("alpha"));
    let before = p.discussion("alpha");

    let out = p.run(&["new", "change", "beta", "--last"]);
    assert_eq!(out.status.code(), Some(2), "usage error: {}", String::from_utf8_lossy(&out.stderr));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("--from-discussion"),
        "stderr 说明 --last 需要 --from-discussion: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!p.dir.join("specseal").join("changes").join("beta").exists(), "不建目录");
    assert_eq!(p.discussion("alpha"), before, "记录逐比特不变");
}

#[test]
fn discuss_list_json_never_carries_a_hold_key() {
    // 规格「讨论列表回应携带 concluded」的 THEN：本地 CLI 的 discuss list --json
    // 逐比特不变——hold 住在 head 的 serde(skip) 字段里，这里钉一句守门。
    let p = TempProject::with_discussion("list-json", "alpha", &held_doc("alpha"));
    let out = p.run(&["discuss", "list", "--json"]);
    ok(&out);
    let text = stdout_of(&out);
    assert!(text.contains("\"slug\": \"alpha\""), "带 hold 的记录照列: {text}");
    assert!(!text.contains("\"hold\""), "CLI JSON 无 hold 键: {text}");
}

#[test]
fn conclude_with_hold_refuses_a_record_without_frontmatter() {
    // 规格「无 frontmatter 的记录拒绝 --hold」：带 --hold 非零收场、记录不变；
    // 不带 --hold 沿 pre-scaffold 既有路径照常结论。
    let bare = "# Discussion: bare\n\n## Rounds\n";
    let p = TempProject::with_discussion("bare", "bare", bare);
    let path = p.dir.join("specseal").join("discussions").join("bare.md");

    let out = p.run_stdin(&["discuss", "conclude", "bare", "--stdin", "--hold"], "**Decision**: x\n");
    assert!(!out.status.success(), "带 --hold 必须拒绝");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("no frontmatter"), "stderr 说明原因: {err}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), bare, "记录逐比特不变");

    let out = p.run_stdin(&["discuss", "conclude", "bare", "--stdin"], "**Decision**: x\n");
    ok(&out);
    assert!(std::fs::read_to_string(&path).unwrap().contains("## Conclusion"));
}

#[test]
fn discuss_archive_ignores_the_hold_flag() {
    // 手动封存＝放弃后续刀的明示出口：带 hold 的记录照常封存。
    let p = TempProject::with_discussion("manual", "alpha", &promoted_unconcluded_doc("alpha"));
    ok(&p.run_stdin(
        &["discuss", "conclude", "alpha", "--stdin", "--hold"],
        "**Decision**: cut-b later\n",
    ));

    let out = p.run(&["discuss", "archive", "alpha"]);
    ok(&out);

    assert!(!p.live_exists("alpha"));
    assert!(p.archived_exists("alpha"));
}
