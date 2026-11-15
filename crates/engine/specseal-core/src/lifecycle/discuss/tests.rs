use crate::store::Store;
use crate::teststore::TestStore;

/// A scaffolded discussion document with a written conclusion.
fn concluded_doc(slug: &str, topic: &str, decision: &str) -> String {
    format!(
        "---\ntopic: {topic}\nslug: {slug}\nstatus: concluded\ncreated: 2026-01-02\n---\n\n\
             # Discussion: {topic}\n\n\
             ## Context\n\nFixture context.\n\n\
             ## Rounds\n\n### Round 1 — assumptions (2026-01-02)\n\n**Focus**: scope\n\n\
             ## Conclusion\n\n**Decision**: {decision}\n"
    )
}

/// A scaffolded discussion whose conclusion is still the placeholder comment.
fn open_doc(slug: &str, topic: &str) -> String {
    format!(
        "---\ntopic: {topic}\nslug: {slug}\nstatus: open\ncreated: 2026-01-02\n---\n\n\
             # Discussion: {topic}\n\n\
             ## Context\n\nFixture context.\n\n\
             ## Rounds\n\n\
             ## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n"
    )
}

/// A promoted discussion (spin-out already recorded) whose conclusion is still the
/// placeholder comment — the mid-discussion spin-out state.
fn promoted_unconcluded_doc(slug: &str, promoted_to: &str) -> String {
    format!(
        "---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\npromoted_to: {promoted_to}\ncreated: 2026-01-02\n---\n\n\
             # Discussion: {slug}\n\n\
             ## Context\n\nFixture context.\n\n\
             ## Rounds\n\n\
             ## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n"
    )
}

// --- conclude 闭环（conclusion-gated-discussion-archive）---

#[test]
fn conclude_auto_archives_when_all_promoted_changes_are_archived() {
    // promoted_to 非空、无在途变更引用 → conclude 顺手封存，结论随记录进封存区。
    let store = TestStore::with_live_discussion("alpha", &promoted_unconcluded_doc("alpha", "cut"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: done", false).unwrap();

    assert!(outcome.auto_archived, "outcome carries the auto-archive fact");
    assert!(!store.live_discussion_exists("alpha"), "record leaves the live set");
    assert!(store.archived_discussion_exists("alpha"));
    let archived = store.archived_discussions.borrow().get("alpha").cloned().unwrap();
    assert!(archived.contains("**Decision**: done"), "conclusion travels into the archive");
    assert!(archived.contains("status: promoted"), "promoted status is preserved");
}

#[test]
fn conclude_leaves_record_live_while_promoted_change_in_flight() {
    // 仍有在途变更引用 → 只写结论，不封存。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-01-02\nfrom_discussion: alpha\n",
    );
    store
        .discussions
        .borrow_mut()
        .insert("alpha".into(), promoted_unconcluded_doc("alpha", "cut"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: done", false).unwrap();

    assert!(!outcome.auto_archived);
    assert!(store.live_discussion_exists("alpha"), "record stays live");
    assert!(!store.archived_discussion_exists("alpha"));
    assert!(store.discussion("alpha").contains("**Decision**: done"));
}

#[test]
fn conclude_without_promotion_keeps_existing_behavior() {
    // promoted_to 缺席 → 行为不变：status 转 concluded、记录留在途。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: done", false).unwrap();

    assert!(!outcome.auto_archived);
    assert!(store.live_discussion_exists("alpha"));
    assert!(!store.archived_discussion_exists("alpha"));
    assert!(store.discussion("alpha").contains("status: concluded"));
}

#[test]
fn conclude_archive_step_failure_keeps_conclusion_and_outcome() {
    // 闭环封存步失败 → 结论与 restale 结果照常回传（Ok），失败原因入
    // closing_error 由调用端呈现；结论写入不回滚（已结论、仍在途）。
    // 命令层回 Ok 也让 remote 的 Unit of Work 照常 commit——「不回滚」
    // 在本机与 remote 同语意。
    let store = TestStore::with_live_discussion("alpha", &promoted_unconcluded_doc("alpha", "cut"));
    *store.fail_archive_discussion.borrow_mut() = true;

    let outcome = super::conclude(&store, "alpha", "**Decision**: done", false).unwrap();

    assert!(!outcome.auto_archived);
    assert!(
        outcome.closing_error.as_deref().unwrap_or("").contains("simulated"),
        "closing failure reason travels in the outcome: {:?}",
        outcome.closing_error
    );
    assert!(store.live_discussion_exists("alpha"), "record stays live");
    assert!(
        store.discussion("alpha").contains("**Decision**: done"),
        "conclusion is not rolled back"
    );
}

#[test]
fn conclude_closing_step_fails_closed_on_corrupt_change_meta() {
    // 坏 meta fail-closed（与 link 的纪律一致）：在途变更的 .meta.yaml
    // 解析失败时，读不出它引用谁——视同仍引用，不误封存讨论。
    const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
    let store = TestStore::with_meta("broken-cut", BAD);
    store
        .discussions
        .borrow_mut()
        .insert("alpha".into(), promoted_unconcluded_doc("alpha", "broken-cut"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: done", false).unwrap();

    assert!(!outcome.auto_archived, "corrupt in-flight meta blocks the closing step");
    assert!(outcome.closing_error.is_none());
    assert!(store.live_discussion_exists("alpha"), "record stays live");
    assert!(!store.archived_discussion_exists("alpha"));
}

// --- hold 旗标（discussion-spinout-hold）---

/// 带 `hold: true` 的已转出讨论——分期立案（下一刀还没创建）的在途状态。
fn held_promoted_doc(slug: &str, promoted_to: &str) -> String {
    format!(
        "---\ntopic: {slug}\nslug: {slug}\nstatus: promoted\npromoted_to: {promoted_to}\ncreated: 2026-01-02\nhold: true\n---\n\n\
             # Discussion: {slug}\n\n\
             ## Context\n\nFixture context.\n\n\
             ## Rounds\n\n\
             ## Conclusion\n\n<!-- Written by `specseal discuss conclude` -->\n"
    )
}

#[test]
fn conclude_with_hold_writes_the_flag_and_keeps_status_rules() {
    // 带 hold：旗标入 frontmatter，status 转换规则（open -> concluded）不变。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: done", true).unwrap();

    assert!(outcome.held, "outcome 记录本次写入后带旗标");
    let text = store.discussion("alpha");
    assert!(DiscussionHead::parse(&text).hold, "frontmatter 带 hold: true");
    assert!(DiscussionHead::parse(&store.discussion("alpha")).hold);
    assert!(text.contains("status: concluded"), "status 转换规则不变");
    assert!(text.contains("**Decision**: done"), "结论与旗标同一次落盘");
}

#[test]
fn conclude_without_hold_removes_an_existing_flag() {
    // 不带 hold 的再次 conclude＝重述意图：既有旗标行消失。
    // 在途变更引用本讨论，闭环不触发，记录留在途可供查看。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-01-02\nfrom_discussion: alpha\n",
    );
    store.discussions.borrow_mut().insert("alpha".into(), held_promoted_doc("alpha", "cut"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: redone", false).unwrap();

    assert!(!outcome.held);
    let text = store.discussion("alpha");
    assert!(!DiscussionHead::parse(&text).hold, "旗标行被移除");
    assert!(!text.contains("hold: true"), "整行消失，不留残句");
    assert!(text.contains("status: promoted"), "promoted 状态保持");
}

#[test]
fn mark_promoted_keeps_the_hold_flag() {
    // 转出下一刀不是旗标的偿还：promoted_to 累加、hold 行逐字留着，
    // 整个分期系列只做一次 conclude --hold。
    let store = TestStore::with_live_discussion("alpha", &held_promoted_doc("alpha", "cut-a"));

    super::mark_promoted(&store, "alpha", "cut-b", false).unwrap();

    let text = store.discussion("alpha");
    assert!(text.contains("promoted_to: cut-a, cut-b"), "累加下一刀");
    assert!(DiscussionHead::parse(&text).hold, "转出不清旗标");
    assert!(text.contains("hold: true"));
}

#[test]
fn link_and_seal_both_leave_the_hold_flag_untouched() {
    // link 对讨论记录逐比特不变；补标的 seal 累加名字，旗标一样不动。
    let doc = held_promoted_doc("alpha", "cut-a");
    let store = TestStore::with_meta("cut-b", "schema: spec-driven\ncreated: 2026-01-02\n");
    store.discussions.borrow_mut().insert("alpha".into(), doc.clone());

    super::link(&store, "alpha", "cut-b").unwrap();
    assert_eq!(store.discussion("alpha"), doc, "link 不改讨论记录");

    super::seal(&store, "alpha", "cut-b", false).unwrap();
    let text = store.discussion("alpha");
    assert!(text.contains("promoted_to: cut-a, cut-b"));
    assert!(DiscussionHead::parse(&text).hold, "seal 经 mark_promoted 也不清旗标");
}

#[test]
fn mark_promoted_keeps_the_hold_flag_when_nothing_accumulates() {
    // 幂等分支（promoted_to 已含该变更名）连 promoted_to 都不动：re-ingest
    // 旧变更的 seal 让记录逐比特不变，旗标自然跟着留着。
    let store = TestStore::with_live_discussion("alpha", &held_promoted_doc("alpha", "cut-a"));

    super::mark_promoted(&store, "alpha", "cut-a", false).unwrap();

    let text = store.discussion("alpha");
    assert!(DiscussionHead::parse(&text).hold, "没有新刀累加，旗标保留");
    assert!(text.contains("promoted_to: cut-a\n"), "promoted_to 不变");
}

#[test]
fn conclude_with_hold_rejects_a_record_without_frontmatter() {
    // 无 frontmatter 放不下旗标：带 hold 明确报错、不落盘；不带 hold 沿
    // pre-scaffold 既有路径照常结论。
    let doc = "# Discussion: bare\n\n## Rounds\n";
    let store = TestStore::with_live_discussion("bare", doc);

    assert!(super::conclude(&store, "bare", "**Decision**: x", true).is_err());
    assert_eq!(store.discussion("bare"), doc, "拒绝时记录逐比特不变");

    let outcome = super::conclude(&store, "bare", "**Decision**: x", false).unwrap();
    assert!(!outcome.held);
    assert!(store.discussion("bare").contains("## Conclusion"));
}

#[test]
fn conclude_rewrites_a_hand_edited_hold_line_in_place() {
    // 以 key 为单位改写：手改成 hold: false 的行被原位换成 true（不另插一行），
    // 不带 hold 时任何 hold: 行都移除。读写两边看法一致。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-01-02\nfrom_discussion: alpha\n",
    );
    let doc = held_promoted_doc("alpha", "cut").replacen("hold: true\n", "hold: false\n", 1);
    store.discussions.borrow_mut().insert("alpha".into(), doc);

    let outcome = super::conclude(&store, "alpha", "**Decision**: later", true).unwrap();
    assert!(outcome.held);
    let text = store.discussion("alpha");
    assert_eq!(text.matches("\nhold:").count(), 1, "只有一行 hold:");
    assert!(DiscussionHead::parse(&text).hold);

    store.discussions.borrow_mut().insert(
        "alpha".into(),
        held_promoted_doc("alpha", "cut").replacen("hold: true\n", "hold: yes\n", 1),
    );
    let outcome = super::conclude(&store, "alpha", "**Decision**: done", false).unwrap();
    assert!(!outcome.held);
    assert!(!store.discussion("alpha").contains("\nhold:"), "任何 hold: 行都移除");
}

#[test]
fn conclude_with_hold_follows_the_record_line_ending() {
    // CRLF 记录：插入的旗标行沿该档行尾，不混排。
    let doc = open_doc("alpha", "Alpha").replace('\n', "\r\n");
    let store = TestStore::with_live_discussion("alpha", &doc);

    let outcome = super::conclude(&store, "alpha", "**Decision**: done", true).unwrap();

    assert!(outcome.held);
    let text = store.discussion("alpha");
    assert!(text.contains("hold: true\r\n---"), "旗标行以 CRLF 收尾: {text:?}");
    assert!(DiscussionHead::parse(&text).hold);
}

#[test]
fn frontmatter_line_surgery_on_unclosed_frontmatter_matches_the_reader() {
    // 未闭合 frontmatter（缺尾 ---）：读端把整档当 frontmatter，
    // 写端要同样宽松——既有行原位代换、移除照做；只有「要新插一行却找不到尾」才拒绝。
    let unclosed = "---\ntopic: x\nslug: x\nstatus: open\nboard_rank: b\nhold: true\n";
    let store = TestStore::with_live_discussion("x", unclosed);

    super::set_board_rank(&store, "x", "n").unwrap();
    assert_eq!(store.discussion("x"), unclosed.replacen("board_rank: b", "board_rank: n", 1));

    let outcome = super::conclude(&store, "x", "**Decision**: done", false).unwrap();
    assert!(!outcome.held);
    assert!(!store.discussion("x").contains("hold:"), "未闭合仍能移除旗标");
    assert!(!DiscussionHead::parse(&store.discussion("x")).hold, "读写两端看法一致");

    let bare = "---\ntopic: y\nslug: y\nstatus: open\n";
    let store = TestStore::with_live_discussion("y", bare);
    assert!(super::conclude(&store, "y", "**Decision**: x", true).is_err(), "没有尾行可插");
    assert_eq!(store.discussion("y"), bare);
}

#[test]
fn mark_promoted_lands_promoted_to_on_a_crlf_record_and_keeps_the_hold() {
    // 旧版以 "status: promoted\n" 做 replacen，CRLF 记录的 promoted_to 落空（前身
    // 测试钉的就是那个破口）。改走 head 之后 promoted_to 沿该档行尾落地；旗标则
    // 不论行尾一律留着。
    let doc = open_doc("alpha", "Alpha")
        .replacen("created: 2026-01-02\n", "created: 2026-01-02\nhold: true\n", 1)
        .replace('\n', "\r\n");
    let store = TestStore::with_live_discussion("alpha", &doc);

    super::mark_promoted(&store, "alpha", "cut-b", false).unwrap();

    let text = store.discussion("alpha");
    assert!(text.contains("status: promoted\r\n"), "status 原位代换沿 CRLF: {text:?}");
    assert!(text.contains("promoted_to: cut-b\r\n---"), "promoted_to 沿 CRLF 落地: {text:?}");
    assert!(DiscussionHead::parse(&text).hold, "转出不清旗标");
    assert!(text.contains("hold: true\r\n"), "旗标行沿 CRLF 逐字保留: {text:?}");
}

// --- 最后一刀（discussion-last-cut-release）---

#[test]
fn head_promote_last_new_change_drops_the_hold_and_returns_true() {
    // 带 --last 的转出：累加新刀的同一次写入把 hold 行整行移除，其余字节不动。
    let doc = held_promoted_doc("alpha", "cut-a");
    let mut head = DiscussionHead::parse(&doc);
    assert!(head.promote("cut-b", true));
    assert_eq!(head.status, Status::Promoted);
    assert_eq!(head.promoted_to, vec!["cut-a", "cut-b"]);
    assert!(!head.hold, "最后一刀解除旗标");
    let text = head.write_back().unwrap().unwrap();
    assert!(text.contains("promoted_to: cut-a, cut-b\n"), "累加下一刀: {text}");
    assert!(!text.contains("hold:"), "hold 行整行消失: {text}");
    assert_eq!(
        text,
        doc.replace("promoted_to: cut-a\n", "promoted_to: cut-a, cut-b\n").replace("hold: true\n", ""),
        "除 promoted_to 与 hold 行外逐比特不变"
    );
}

#[test]
fn head_promote_last_known_change_drops_the_hold_and_returns_false() {
    // 名字已在清单（重复转出、re-ingest 的 seal）：promoted_to 不变，旗标照样解除——
    // 忘了在立最后一刀时带旗标，seal --last 就是不经 conclude 的补救路（design D2）。
    let doc = held_promoted_doc("alpha", "cut-a");
    let mut head = DiscussionHead::parse(&doc);
    assert!(!head.promote("cut-a", true));
    assert!(!head.hold);
    assert_eq!(
        head.write_back().unwrap().as_deref(),
        Some(doc.replace("hold: true\n", "").as_str()),
        "promoted_to 不变、只少 hold 行"
    );
}

#[test]
fn head_promote_last_without_a_hold_line_changes_nothing_beyond_promoted_to() {
    // 无 hold 行的记录带 --last 是无害的无操作：与不带旗标的转出结果逐比特相同。
    let doc = open_doc("alpha", "Alpha");
    let mut with_last = DiscussionHead::parse(&doc);
    let mut without = DiscussionHead::parse(&doc);
    assert!(with_last.promote("cut", true));
    assert!(without.promote("cut", false));
    assert_eq!(with_last.write_back().unwrap(), without.write_back().unwrap());
}

#[test]
fn mark_promoted_last_drops_the_hold_on_a_crlf_record() {
    // 旗标的移除沿记录的行尾：CRLF 记录少掉整行 `hold: true\r\n`，其余行尾不变。
    let doc = open_doc("alpha", "Alpha")
        .replacen("created: 2026-01-02\n", "created: 2026-01-02\nhold: true\n", 1)
        .replace('\n', "\r\n");
    let store = TestStore::with_live_discussion("alpha", &doc);

    super::mark_promoted(&store, "alpha", "cut-b", true).unwrap();

    let text = store.discussion("alpha");
    assert!(text.contains("promoted_to: cut-b\r\n---"), "promoted_to 沿 CRLF 落地: {text:?}");
    assert!(!text.contains("hold"), "hold 行整行消失: {text:?}");
    assert!(!DiscussionHead::parse(&text).hold);
    assert!(!text.replace("\r\n", "").contains('\n'), "行尾仍是 CRLF、没有混入 LF: {text:?}");
}

#[test]
fn seal_last_drops_the_hold_even_when_nothing_accumulates() {
    // seal --last 对已在清单的变更：promoted_to 逐字不变、hold 行消失。
    let store = TestStore::with_meta(
        "cut-a",
        "schema: spec-driven\ncreated: 2026-01-02\nfrom_discussion: alpha\n",
    );
    let doc = held_promoted_doc("alpha", "cut-a");
    store.discussions.borrow_mut().insert("alpha".into(), doc.clone());

    super::seal(&store, "alpha", "cut-a", true).unwrap();

    let text = store.discussion("alpha");
    assert_eq!(text, doc.replace("hold: true\n", ""), "只少 hold 行");
}

#[test]
fn promote_last_drops_the_hold_while_creating_the_change() {
    // 三条转出路径之一：promote --last 建变更＋累加＋解除旗标同一次落地。
    let store = TestStore::with_live_discussion("alpha", &held_promoted_doc("alpha", "cut-a"));

    let outcome = super::promote(&store, "alpha", Some("cut-b"), None, true).unwrap();

    assert_eq!(outcome.change, "cut-b");
    let text = store.discussion("alpha");
    assert!(text.contains("promoted_to: cut-a, cut-b\n"), "累加下一刀: {text}");
    assert!(!text.contains("hold:"), "最后一刀解除旗标: {text}");
    assert!(store.read_change_meta("cut-b").is_some(), "变更同时创建");
}

#[test]
fn conclude_with_hold_skips_the_closing_archive() {
    // 闭环条件（promoted_to 非空、无在途引用）成立，但带 hold → 不封存、留在途。
    let store = TestStore::with_live_discussion("alpha", &promoted_unconcluded_doc("alpha", "cut"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: cut-b later", true).unwrap();

    assert!(!outcome.auto_archived, "带 hold 必然不闭环");
    assert!(outcome.held);
    assert!(outcome.closing_error.is_none());
    assert!(store.live_discussion_exists("alpha"), "记录留在 live 集合");
    assert!(!store.archived_discussion_exists("alpha"));
    assert!(DiscussionHead::parse(&store.discussion("alpha")).hold);
}

#[test]
fn conclude_with_hold_does_not_duplicate_the_flag_line() {
    // 重复带 hold：旗标行只有一条。
    let store = TestStore::with_meta(
        "cut",
        "schema: spec-driven\ncreated: 2026-01-02\nfrom_discussion: alpha\n",
    );
    store.discussions.borrow_mut().insert("alpha".into(), held_promoted_doc("alpha", "cut"));

    let outcome = super::conclude(&store, "alpha", "**Decision**: still deferred", true).unwrap();

    assert!(outcome.held);
    let text = store.discussion("alpha");
    assert_eq!(text.matches("hold: true").count(), 1, "不产生第二行");
}

// --- 空内容 guard（discuss-content-guard；拒绝静默写入空区段） ---

#[test]
fn add_round_rejects_empty_content() {
    let doc = open_doc("alpha", "Alpha");
    let store = TestStore::with_live_discussion("alpha", &doc);
    assert!(super::add_round(&store, "alpha", "assumptions", "").is_err());
    assert!(super::add_round(&store, "alpha", "assumptions", "   \n\t ").is_err());
    assert_eq!(store.discussion("alpha"), doc, "空内容不得改动记录");
}

#[test]
fn conclude_rejects_empty_content_and_keeps_status() {
    let doc = open_doc("alpha", "Alpha");
    let store = TestStore::with_live_discussion("alpha", &doc);
    assert!(super::conclude(&store, "alpha", "", false).is_err());
    assert!(super::conclude(&store, "alpha", "  \n ", false).is_err());
    assert_eq!(
        store.discussion("alpha"),
        doc,
        "空 conclude 不得翻状态或改动记录"
    );
}

#[test]
fn set_context_rejects_empty_content() {
    let doc = open_doc("alpha", "Alpha");
    let store = TestStore::with_live_discussion("alpha", &doc);
    assert!(super::set_context(&store, "alpha", "").is_err());
    assert!(super::set_context(&store, "alpha", "   ").is_err());
    assert_eq!(store.discussion("alpha"), doc, "空内容不得覆写 Context");
}

// --- board_rank（看板排序字段；desktop-card-reorder） ---

#[test]
fn board_rank_reads_frontmatter_only() {
    // 读取限 frontmatter：本文出现「board_rank:」字样不得误读。
    let rank_of = |text: &str| super::info_from_doc(&doc_of("alpha", text)).head.board_rank;
    assert!(rank_of(&open_doc("alpha", "Alpha")).is_none());

    let with_rank = open_doc("alpha", "Alpha")
        .replacen("status: open\n", "status: open\nboard_rank: n\n", 1);
    assert_eq!(rank_of(&with_rank).as_deref(), Some("n"));

    let body_decoy = open_doc("alpha", "Alpha") + "\nboard_rank: fake\n";
    assert!(rank_of(&body_decoy).is_none());
}

#[test]
fn set_board_rank_inserts_into_frontmatter_preserving_rest_verbatim() {
    // spec「meta 写入路径对 board_rank 互不破坏」讨论侧：插入 frontmatter
    // 尾端（closing --- 前），其余内容逐字节不变。
    let doc = open_doc("alpha", "Alpha");
    let store = TestStore::with_live_discussion("alpha", &doc);
    super::set_board_rank(&store, "alpha", "n").unwrap();
    let expected = doc.replacen(
        "created: 2026-01-02\n---\n",
        "created: 2026-01-02\nboard_rank: n\n---\n",
        1,
    );
    assert_eq!(store.discussion("alpha"), expected);
}

#[test]
fn set_board_rank_replaces_existing_frontmatter_line_in_place() {
    let doc = open_doc("alpha", "Alpha")
        .replacen("status: open\n", "status: open\nboard_rank: b\n", 1);
    let store = TestStore::with_live_discussion("alpha", &doc);
    super::set_board_rank(&store, "alpha", "abn").unwrap();
    assert_eq!(
        store.discussion("alpha"),
        doc.replacen("board_rank: b\n", "board_rank: abn\n", 1)
    );
}

#[test]
fn set_board_rank_rejects_invalid_values_and_non_live_records() {
    // 值验证同变更侧（仅小写英文本母）；封存记录不上看板、不可写。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    for bad in ["", "N", "a1", "a b", "a\nstatus: forged"] {
        assert!(
            super::set_board_rank(&store, "alpha", bad).is_err(),
            "invalid rank {bad:?} must be rejected"
        );
    }
    assert_eq!(store.discussion("alpha"), open_doc("alpha", "Alpha"), "no write on reject");

    let archived = TestStore::default();
    archived
        .archived_discussions
        .borrow_mut()
        .insert("old".to_string(), concluded_doc("old", "Old", "done"));
    assert!(super::set_board_rank(&archived, "old", "n").is_err());
    assert!(super::set_board_rank(&archived, "ghost", "n").is_err());
}

#[test]
fn discussion_info_json_is_unchanged_by_board_rank() {
    // spec「board_rank 不进 CLI 输出且既有输出逐比特不变」讨论侧：
    // DiscussionInfo 不携带 rank（沿 promoted_to 的独立读取模式），
    // 含 rank 的记录串行化结果与无 rank 时逐比特一致。
    let doc = open_doc("alpha", "Alpha");
    let with_rank = doc.replacen("status: open\n", "status: open\nboard_rank: n\n", 1);
    let info_of = |text: &str| {
        serde_json::to_string(&super::info_from_doc(&crate::store::DiscussionDoc {
            slug: "alpha".to_string(),
            text: text.to_string(),
            path: std::path::PathBuf::from("discussions/alpha.md"),
            archived: false,
        }))
        .unwrap()
    };
    let ranked_json = info_of(&with_rank);
    assert_eq!(ranked_json, info_of(&doc), "board_rank must not affect discuss list --json");
    assert!(!ranked_json.contains("board_rank") && !ranked_json.contains("boardRank"));
}

// --- promote flow (design D1) ---

#[test]
fn promote_rejects_missing_discussion() {
    let store = TestStore::default();
    let err = super::promote(&store, "ghost", None, None, false).unwrap_err();
    assert!(err.to_string().contains("not found"), "err: {err}");
}

#[test]
fn promote_rejects_archived_discussion() {
    let store = TestStore::default();
    store
        .archived_discussions
        .borrow_mut()
        .insert("old-topic".to_string(), concluded_doc("old-topic", "Old", "done"));
    let err = super::promote(&store, "old-topic", None, None, false).unwrap_err();
    assert!(err.to_string().contains("archived"), "err: {err}");
    assert!(!store.change_exists("old-topic"), "no change may be created");
}

#[test]
fn promote_derives_change_name_from_slug_by_default() {
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "build alpha search"),
    );
    let outcome = super::promote(&store, "alpha-search", None, None, false).unwrap();
    assert_eq!(outcome.change, "alpha-search");
    assert!(store.change_exists("alpha-search"));
}

#[test]
fn promote_uses_explicit_name_when_given() {
    let store = TestStore::with_live_discussion(
        "beta-cache",
        &concluded_doc("beta-cache", "Beta cache", "add cache layer"),
    );
    let outcome =
        super::promote(&store, "beta-cache", Some("cache-layer"), None, false).unwrap();
    assert_eq!(outcome.change, "cache-layer");
    assert!(store.change_exists("cache-layer"));
    assert!(!store.change_exists("beta-cache"));
}

#[test]
fn promote_strips_archive_date_prefix_from_derived_name() {
    // Archive-style date prefixes are historical references, not active
    // change names — derivation normalizes them away (either form).
    let store = TestStore::with_live_discussion(
        "2026-07-06-retro",
        &concluded_doc("2026-07-06-retro", "Retro", "do the retro"),
    );
    let outcome = super::promote(&store, "2026-07-06-retro", None, None, false).unwrap();
    assert_eq!(outcome.change, "retro");

    let store2 = TestStore::with_live_discussion(
        "gamma-x",
        &concluded_doc("gamma-x", "Gamma x", "ship gamma"),
    );
    let outcome2 =
        super::promote(&store2, "gamma-x", Some("2026-01-02-gamma-cut"), None, false).unwrap();
    assert_eq!(outcome2.change, "gamma-cut");
}

#[test]
fn promote_creates_change_with_from_discussion_meta() {
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "build alpha search"),
    );
    super::promote(&store, "alpha-search", None, None, false).unwrap();
    let meta = store.meta("alpha-search");
    assert!(meta.starts_with("schema: spec-driven\ncreated: "), "meta: {meta}");
    assert!(meta.contains("from_discussion: alpha-search\n"), "meta: {meta}");
}

#[test]
fn promote_prefills_proposal_why_from_conclusion() {
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "build alpha search"),
    );
    super::promote(&store, "alpha-search", None, None, false).unwrap();
    let proposal = store.read_artifact("alpha-search", "proposal.md").unwrap();
    assert_eq!(
        proposal,
        "## Why\n\n**Decision**: build alpha search\n\n## What Changes\n\n<!-- TBD: derive from the discussion -->\n\n## Capabilities\n\n### New Capabilities\n\n<!-- TBD -->\n\n## Impact\n\n<!-- TBD -->\n"
    );
}

#[test]
fn promote_prefills_topic_when_no_conclusion() {
    // Placeholder-only conclusion → the topic is the Why fallback.
    let store =
        TestStore::with_live_discussion("open-one", &open_doc("open-one", "Open topic"));
    super::promote(&store, "open-one", None, None, false).unwrap();
    let proposal = store.read_artifact("open-one", "proposal.md").unwrap();
    assert!(proposal.starts_with("## Why\n\nOpen topic\n"), "proposal: {proposal}");
}

#[test]
fn promote_marks_promoted_and_accumulates_on_fan_out() {
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "build alpha search"),
    );
    super::promote(&store, "alpha-search", None, None, false).unwrap();
    let text = store.discussion("alpha-search");
    assert!(text.contains("status: promoted\n"), "text: {text}");
    assert!(text.contains("promoted_to: alpha-search\n"), "text: {text}");

    // Second cut: promoted_to becomes a comma-separated accumulator.
    super::promote(&store, "alpha-search", Some("second-cut"), None, false).unwrap();
    let text = store.discussion("alpha-search");
    assert!(text.contains("promoted_to: alpha-search, second-cut\n"), "text: {text}");
}

#[test]
fn promote_fails_when_change_already_exists_and_leaves_discussion_untouched() {
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "build alpha search"),
    );
    store.metas.borrow_mut().insert("alpha-search".to_string(), "schema: spec-driven\n".to_string());
    let before = store.discussion("alpha-search");
    let err = super::promote(&store, "alpha-search", None, None, false).unwrap_err();
    assert!(err.to_string().contains("already exists"), "err: {err}");
    assert_eq!(store.discussion("alpha-search"), before, "discussion must not be marked");
}

#[test]
fn promote_fails_before_any_change_lands_when_the_record_cannot_take_the_link() {
    // review Round 2：未闭合 frontmatter 且缺 promoted_to 的手写记录——标记步无处插行
    // 会 Err；那个检查必须在建 change 之前做，否则留下「change 已建、动词报错」的半成品。
    let unclosed = "---\ntopic: x\nslug: x\nstatus: concluded\n";
    let store = TestStore::with_live_discussion("x", unclosed);
    assert!(super::promote(&store, "x", Some("cut-x"), None, false).is_err());
    assert!(!store.change_exists("cut-x"), "没有半成品 change");
    assert_eq!(store.discussion("x"), unclosed, "记录逐比特不变");
}

// --- promoted_to query (design D2) ---

#[test]
fn promoted_to_absent_yields_empty() {
    let store =
        TestStore::with_live_discussion("open-one", &open_doc("open-one", "Open topic"));
    assert!(super::promoted_to(&store, "open-one").is_empty());
    assert!(super::promoted_to(&store, "no-such-slug").is_empty());
}

#[test]
fn promoted_to_single_value() {
    let mut doc = concluded_doc("alpha-search", "Alpha search", "x");
    doc = doc.replacen(
        "status: concluded\n",
        "status: promoted\npromoted_to: first-cut\n",
        1,
    );
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    assert_eq!(super::promoted_to(&store, "alpha-search"), vec!["first-cut".to_string()]);
}

#[test]
fn promoted_to_comma_accumulated_values() {
    let mut doc = concluded_doc("alpha-search", "Alpha search", "x");
    doc = doc.replacen(
        "status: concluded\n",
        "status: promoted\npromoted_to: first-cut, second-cut\n",
        1,
    );
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    assert_eq!(
        super::promoted_to(&store, "alpha-search"),
        vec!["first-cut".to_string(), "second-cut".to_string()]
    );
}

#[test]
fn promoted_to_reads_archived_records_too() {
    // The archived page needs the fan-out list for auto-archived discussions.
    let mut doc = concluded_doc("done-topic", "Done", "x");
    doc = doc.replacen(
        "status: concluded\n",
        "status: promoted\npromoted_to: only-cut\n",
        1,
    );
    let store = TestStore::default();
    store.archived_discussions.borrow_mut().insert("done-topic".to_string(), doc);
    assert_eq!(super::promoted_to(&store, "done-topic"), vec!["only-cut".to_string()]);
}

// --- unlink on discard（spec「讨论随变更废弃解链」；design D2） ---

/// concluded_doc 提升为 promoted，promoted_to 设为指定清单。
fn promoted_concluded(slug: &str, topic: &str, decision: &str, to: &str) -> String {
    concluded_doc(slug, topic, decision).replacen(
        "status: concluded\n",
        &format!("status: promoted\npromoted_to: {to}\n"),
        1,
    )
}

#[test]
fn unlink_reverts_to_concluded_when_last_link_dies() {
    // spec Example「回退前后的 frontmatter」＋「最后链接死亡回退 concluded」：
    // 唯一值移除 → promoted_to 行消失、status 回 concluded；Context/Rounds/Conclusion
    // 逐比特不变（回退后 == 原 concluded 记录）。
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &promoted_concluded("alpha-search", "Alpha search", "build alpha search", "cut-a"),
    );
    let reverted = super::unlink_discarded(&store, "alpha-search", "cut-a").unwrap();
    assert_eq!(reverted.as_deref(), Some("concluded"));
    assert_eq!(
        store.discussion("alpha-search"),
        concluded_doc("alpha-search", "Alpha search", "build alpha search"),
        "promoted_to 行消失、status 回 concluded、其余逐比特不变"
    );
}

#[test]
fn unlink_shrinks_list_and_keeps_promoted_when_others_remain() {
    // spec「仍有其他变更时维持 promoted」：多值仅缩减、status 维持 promoted。
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &promoted_concluded("alpha-search", "Alpha search", "x", "cut-a, cut-b"),
    );
    let reverted = super::unlink_discarded(&store, "alpha-search", "cut-a").unwrap();
    assert_eq!(reverted.as_deref(), Some("promoted"));
    assert_eq!(
        store.discussion("alpha-search"),
        promoted_concluded("alpha-search", "Alpha search", "x", "cut-b"),
        "移除 cut-a、保留 cut-b、status 维持 promoted"
    );
}

#[test]
fn unlink_reverts_to_open_when_no_conclusion() {
    // spec「无结论的讨论回退 open」：Conclusion 为空的 open 讨论经 link 后废弃 → 回 open。
    let raised = open_doc("open-one", "Open topic").replacen(
        "status: open\n",
        "status: promoted\npromoted_to: cut\n",
        1,
    );
    let store = TestStore::with_live_discussion("open-one", &raised);
    let reverted = super::unlink_discarded(&store, "open-one", "cut").unwrap();
    assert_eq!(reverted.as_deref(), Some("open"));
    assert_eq!(
        store.discussion("open-one"),
        open_doc("open-one", "Open topic"),
        "promoted_to 行消失、status 回 open、其余逐比特不变"
    );
}

#[test]
fn unlink_skips_missing_record_without_error() {
    // spec「缺失记录跳过」：无 live 记录（不存在或仅存于 archive）→ Ok(None)、不失败。
    let empty = TestStore::default();
    assert_eq!(super::unlink_discarded(&empty, "ghost", "cut").unwrap(), None);

    let archived = TestStore::default();
    archived
        .archived_discussions
        .borrow_mut()
        .insert("old".into(), promoted_concluded("old", "Old", "x", "cut"));
    assert_eq!(super::unlink_discarded(&archived, "old", "cut").unwrap(), None);
}

#[test]
fn unlink_is_idempotent_on_already_unlinked_record() {
    // spec「对已解链的讨论重跑幂等」：重跑对 promoted_to 已无该名的记录 → Ok(None)、不改档。
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &promoted_concluded("alpha-search", "Alpha search", "x", "cut-a"),
    );
    super::unlink_discarded(&store, "alpha-search", "cut-a").unwrap();
    let after_first = store.discussion("alpha-search");
    let rerun = super::unlink_discarded(&store, "alpha-search", "cut-a").unwrap();
    assert_eq!(rerun, None, "已解链记录重跑不回报状态");
    assert_eq!(store.discussion("alpha-search"), after_first, "重跑不改档");
}

#[test]
fn unlink_ignores_a_change_that_was_never_linked() {
    // 幂等的另一面：promoted_to 有值但不含目标变更名 → 不动、不失败、不回报。
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &promoted_concluded("alpha-search", "Alpha search", "x", "cut-a, cut-b"),
    );
    let before = store.discussion("alpha-search");
    assert_eq!(super::unlink_discarded(&store, "alpha-search", "cut-z").unwrap(), None);
    assert_eq!(store.discussion("alpha-search"), before);
}

// --- link flow（spec「讨论以 link 动词并入既有变更」；design D1–D4） ---

#[test]
fn link_writes_change_meta_and_leaves_discussion_untouched() {
    // link 只铸变更侧链：变更 meta 增写 from_discussion，讨论记录逐比特不变
    // （「已转出」标记移交 seal）。
    let doc = concluded_doc("alpha-search", "Alpha search", "build alpha search");
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    store
        .metas
        .borrow_mut()
        .insert("existing-cut".into(), "schema: spec-driven\ncreated: 2026-01-03\n".into());
    super::link(&store, "alpha-search", "existing-cut").unwrap();
    let meta = store.meta("existing-cut");
    assert!(meta.contains("from_discussion: alpha-search\n"), "meta: {meta}");
    assert_eq!(store.discussion("alpha-search"), doc, "讨论逐比特不变（link 不再标记 promoted）");
}

#[test]
fn link_accepts_open_discussion_without_marking() {
    // 前置条件与 promote 一致：open 讨论也可并入；但 link 不翻状态，讨论仍 open。
    let doc = open_doc("open-one", "Open topic");
    let store = TestStore::with_live_discussion("open-one", &doc);
    store.metas.borrow_mut().insert("cut".into(), "schema: spec-driven\n".into());
    super::link(&store, "open-one", "cut").unwrap();
    assert!(store.meta("cut").contains("from_discussion: open-one\n"));
    assert_eq!(store.discussion("open-one"), doc, "讨论仍 open、逐比特不变");
}

#[test]
fn link_rejects_missing_discussion_without_writes() {
    let store = TestStore::default();
    store.metas.borrow_mut().insert("cut".into(), "schema: spec-driven\n".into());
    let err = super::link(&store, "ghost", "cut").unwrap_err();
    assert!(err.to_string().contains("not found"), "err: {err}");
    assert_eq!(store.meta("cut"), "schema: spec-driven\n", "change meta must be untouched");
    assert_eq!(*store.meta_writes.borrow(), 0);
}

#[test]
fn link_rejects_archived_discussion_without_writes() {
    let store = TestStore::default();
    store
        .archived_discussions
        .borrow_mut()
        .insert("old-topic".into(), concluded_doc("old-topic", "Old", "done"));
    store.metas.borrow_mut().insert("cut".into(), "schema: spec-driven\n".into());
    let err = super::link(&store, "old-topic", "cut").unwrap_err();
    assert!(err.to_string().contains("archived"), "err: {err}");
    assert_eq!(store.meta("cut"), "schema: spec-driven\n", "change meta must be untouched");
    assert_eq!(*store.meta_writes.borrow(), 0);
}

#[test]
fn link_rejects_missing_change_without_discussion_write() {
    let doc = concluded_doc("alpha-search", "Alpha search", "x");
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    let err = super::link(&store, "alpha-search", "no-such-change").unwrap_err();
    assert!(err.to_string().contains("not found"), "err: {err}");
    assert_eq!(store.discussion("alpha-search"), doc, "discussion must be untouched");
    assert_eq!(*store.meta_writes.borrow(), 0);
}

#[test]
fn link_example_accumulates_after_an_existing_source_discussion() {
    // spec Example「累加后的 meta 字段」字面值：cut-a 已含 from_discussion: alpha-search，
    // link beta-cache cut-a → from_discussion: alpha-search, beta-cache；alpha-search 不变。
    let alpha = concluded_doc("alpha-search", "Alpha search", "a");
    let store = TestStore::with_live_discussion("alpha-search", &alpha);
    store
        .discussions
        .borrow_mut()
        .insert("beta-cache".into(), concluded_doc("beta-cache", "Beta cache", "b"));
    store
        .metas
        .borrow_mut()
        .insert("cut-a".into(), "schema: spec-driven\nfrom_discussion: alpha-search\n".into());
    super::link(&store, "beta-cache", "cut-a").unwrap();
    assert!(store.meta("cut-a").contains("from_discussion: alpha-search, beta-cache\n"));
    assert_eq!(store.discussion("alpha-search"), alpha, "alpha-search 的记录逐比特不变");
}

#[test]
fn link_appends_to_from_discussion_when_change_already_linked() {
    // spec「出身自讨论的变更再并入新讨论」：change meta 的 from_discussion 于既有值
    // 尾端累加本 slug、既有值保留；本讨论标 promoted；先前链接的讨论记录逐比特不变。
    let doc = concluded_doc("beta-cache", "Beta cache", "x");
    let store = TestStore::with_live_discussion("beta-cache", &doc);
    let other = concluded_doc("other-topic", "Other", "y").replacen(
        "status: concluded\n",
        "status: promoted\npromoted_to: cut\n",
        1,
    );
    store.discussions.borrow_mut().insert("other-topic".into(), other.clone());
    store
        .metas
        .borrow_mut()
        .insert("cut".into(), "schema: spec-driven\nfrom_discussion: other-topic\n".into());
    super::link(&store, "beta-cache", "cut").unwrap();
    let meta = store.meta("cut");
    assert!(meta.contains("from_discussion: other-topic, beta-cache\n"), "meta: {meta}");
    assert_eq!(store.discussion("beta-cache"), doc, "本讨论逐比特不变（link 不标记）");
    assert_eq!(store.discussion("other-topic"), other, "prior discussion untouched");
}

#[test]
fn link_is_idempotent_when_slug_already_in_from_discussion_list() {
    // spec「同一组合重跑为幂等」（该讨论仅为 from_discussion 清单其中一员）：
    // change 侧不再写、讨论侧改写等值内容。
    let store = TestStore::with_live_discussion(
        "beta-cache",
        &concluded_doc("beta-cache", "Beta cache", "x"),
    );
    store.metas.borrow_mut().insert(
        "cut".into(),
        "schema: spec-driven\nfrom_discussion: alpha-search, beta-cache\n".into(),
    );
    super::link(&store, "beta-cache", "cut").unwrap();
    let meta_after = store.meta("cut");
    let writes_after = *store.meta_writes.borrow();
    super::link(&store, "beta-cache", "cut").unwrap();
    assert_eq!(store.meta("cut"), meta_after, "meta must be unchanged");
    assert!(
        meta_after.contains("from_discussion: alpha-search, beta-cache\n"),
        "existing list preserved, not appended: {meta_after}"
    );
    assert_eq!(
        *store.meta_writes.borrow(),
        writes_after,
        "change side must not rewrite when slug already present"
    );
}

#[test]
fn link_rejects_corrupt_change_meta_without_writes() {
    // spec「link 对坏 metadata 拒绝且两侧皆不写」：坏档不得被解读为
    // 「无 from_discussion 链」而追加行——两侧文件逐比特不变。
    const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
    let doc = concluded_doc("alpha-search", "Alpha search", "x");
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    store.metas.borrow_mut().insert("broken-cut".into(), BAD.into());
    let err = super::link(&store, "alpha-search", "broken-cut").unwrap_err();
    assert!(
        err.to_string().contains("specseal/changes/broken-cut/.meta.yaml"),
        "error must name the metadata file: {err}"
    );
    assert_eq!(store.meta("broken-cut"), BAD, "change meta byte-identical");
    assert_eq!(store.discussion("alpha-search"), doc, "discussion byte-identical");
    assert_eq!(*store.meta_writes.borrow(), 0);
}

// --- seal flow（spec「内容落地以 seal 动词标记已转出」） ---

#[test]
fn seal_marks_promoted_when_chain_forged() {
    // 链已铸妥（变更 meta 含 from_discussion: slug）→ 讨论翻 promoted、累加 promoted_to。
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "build alpha search"),
    );
    store.metas.borrow_mut().insert(
        "existing-cut".into(),
        "schema: spec-driven\nfrom_discussion: alpha-search\n".into(),
    );
    super::seal(&store, "alpha-search", "existing-cut", false).unwrap();
    let text = store.discussion("alpha-search");
    assert!(text.contains("status: promoted\n"), "text: {text}");
    assert!(text.contains("promoted_to: existing-cut\n"), "text: {text}");
}

#[test]
fn seal_rejects_when_chain_not_forged_without_writes() {
    // 变更存在但 meta 的 from_discussion 未含该 slug → 拒绝、两侧逐比特不变。
    let doc = concluded_doc("alpha-search", "Alpha search", "x");
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    store.metas.borrow_mut().insert("cut".into(), "schema: spec-driven\n".into());
    let err = super::seal(&store, "alpha-search", "cut", false).unwrap_err();
    assert!(err.to_string().contains("not linked"), "err: {err}");
    assert_eq!(store.discussion("alpha-search"), doc, "discussion untouched");
    assert_eq!(store.meta("cut"), "schema: spec-driven\n", "change meta untouched");
}

#[test]
fn seal_rejects_corrupt_change_meta_not_misreporting_the_chain() {
    // spec「seal 对坏 metadata 拒绝且不误报链缺失」：错误指出 metadata
    // 损坏（而非 from_discussion 不含该 slug）；两侧文件逐比特不变。
    const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
    let doc = concluded_doc("alpha-search", "Alpha search", "x");
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    store.metas.borrow_mut().insert("broken-cut".into(), BAD.into());
    let err = super::seal(&store, "alpha-search", "broken-cut", false).unwrap_err();
    assert!(
        err.to_string().contains("specseal/changes/broken-cut/.meta.yaml"),
        "error must name the metadata file: {err}"
    );
    assert!(
        !err.to_string().contains("not linked"),
        "must not misreport a missing chain: {err}"
    );
    assert_eq!(store.meta("broken-cut"), BAD, "change meta byte-identical");
    assert_eq!(store.discussion("alpha-search"), doc, "discussion byte-identical");
    assert_eq!(*store.meta_writes.borrow(), 0);
}

#[test]
fn seal_rejects_missing_discussion_and_missing_change() {
    // 讨论不存在。
    let store = TestStore::default();
    store.metas.borrow_mut().insert(
        "cut".into(),
        "schema: spec-driven\nfrom_discussion: ghost\n".into(),
    );
    assert!(super::seal(&store, "ghost", "cut", false).unwrap_err().to_string().contains("not found"));
    // 变更不存在（讨论存在）。
    let store2 =
        TestStore::with_live_discussion("alpha", &concluded_doc("alpha", "Alpha", "x"));
    assert!(super::seal(&store2, "alpha", "no-such-change", false).unwrap_err().to_string().contains("not found"));
}

#[test]
fn seal_rejects_archived_discussion() {
    let store = TestStore::default();
    store
        .archived_discussions
        .borrow_mut()
        .insert("old".into(), concluded_doc("old", "Old", "x"));
    store.metas.borrow_mut().insert(
        "cut".into(),
        "schema: spec-driven\nfrom_discussion: old\n".into(),
    );
    assert!(super::seal(&store, "old", "cut", false).unwrap_err().to_string().contains("archived"));
}

#[test]
fn seal_is_idempotent_when_already_promoted() {
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &promoted_concluded("alpha-search", "Alpha search", "x", "existing-cut"),
    );
    store.metas.borrow_mut().insert(
        "existing-cut".into(),
        "schema: spec-driven\nfrom_discussion: alpha-search\n".into(),
    );
    let before = store.discussion("alpha-search");
    super::seal(&store, "alpha-search", "existing-cut", false).unwrap();
    assert_eq!(store.discussion("alpha-search"), before, "重跑不改档");
}

#[test]
fn link_same_pair_is_idempotent() {
    // spec「同一组合重跑为幂等」：Ok、两侧内容逐比特不变、变更侧不再写。
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "x"),
    );
    store.metas.borrow_mut().insert("cut".into(), "schema: spec-driven\n".into());
    super::link(&store, "alpha-search", "cut").unwrap();
    let meta_after = store.meta("cut");
    let doc_after = store.discussion("alpha-search");
    let writes_after = *store.meta_writes.borrow();
    super::link(&store, "alpha-search", "cut").unwrap();
    assert_eq!(store.meta("cut"), meta_after);
    assert_eq!(store.discussion("alpha-search"), doc_after);
    assert_eq!(*store.meta_writes.borrow(), writes_after, "change side must not rewrite");
}

#[test]
fn seal_accumulates_promoted_to_on_fan_out() {
    // spec「promoted_to 逗号累加、既有值保留」：已 promoted 的讨论再经 seal 并入
    // 另一变更（fan-out 累加现由 seal 承接，非 link）。
    let doc = concluded_doc("alpha-search", "Alpha search", "x").replacen(
        "status: concluded\n",
        "status: promoted\npromoted_to: first-cut\n",
        1,
    );
    let store = TestStore::with_live_discussion("alpha-search", &doc);
    store.metas.borrow_mut().insert(
        "second-cut".into(),
        "schema: spec-driven\nfrom_discussion: alpha-search\n".into(),
    );
    super::seal(&store, "alpha-search", "second-cut", false).unwrap();
    let text = store.discussion("alpha-search");
    assert!(text.contains("promoted_to: first-cut, second-cut\n"), "text: {text}");
}

#[test]
fn link_tolerates_meta_without_trailing_newline() {
    // meta 读-改-写的尾换行容错（inprogress 同款模式）。
    let store = TestStore::with_live_discussion(
        "alpha-search",
        &concluded_doc("alpha-search", "Alpha search", "x"),
    );
    store
        .metas
        .borrow_mut()
        .insert("cut".into(), "schema: spec-driven\ncreated: 2026-01-03".into());
    super::link(&store, "alpha-search", "cut").unwrap();
    let meta = store.meta("cut");
    assert!(
        meta.contains("created: 2026-01-03\nfrom_discussion: alpha-search\n"),
        "meta: {meta}"
    );
}

// --- discuss new：slug 覆写与后备衍生（spec「讨论记录以 --slug 覆写文件名」「未带 --slug 时自主题衍生文件名」） ---

#[test]
fn new_discussion_rejects_invalid_slug_override() {
    // spec「非法值一览」Example 表：大写、非 ASCII、底线、空白、首尾连字号、连续连字号、空字符串。
    let store = TestStore::default();
    for bad in [
        "Board-Search",
        "看板搜索",
        "board_search",
        "board search",
        "-board",
        "board-",
        "board--search",
        "",
    ] {
        let err = super::new_discussion(&store, "看板搜索列", Some(bad), None, None, &Default::default()).unwrap_err();
        assert!(err.to_string().contains("kebab-case"), "slug {bad:?} err: {err}");
    }
    assert!(store.list_live_discussions().is_empty(), "invalid slug must not create files");
}

#[test]
fn new_discussion_accepts_valid_slug_override_and_keeps_topic() {
    let store = TestStore::default();
    let info = super::new_discussion(&store, "看板搜索列", Some("board-search-2"), None, None, &Default::default()).unwrap();
    assert_eq!(info.slug, "board-search-2");
    assert_eq!(info.topic, "看板搜索列");
    let text = store
        .read_live_discussion("board-search-2")
        .expect("record stored under override slug");
    assert!(text.contains("slug: board-search-2\n"), "text: {text}");
    assert!(text.contains("topic: 看板搜索列\n"), "text: {text}");
}

#[test]
fn new_discussion_slug_override_conflicts_with_existing() {
    let store = TestStore::with_live_discussion("taken", &open_doc("taken", "Taken"));
    let before = store.discussion("taken");
    let err = super::new_discussion(&store, "另一个主题", Some("taken"), None, None, &Default::default()).unwrap_err();
    assert!(err.to_string().contains("already exists"), "err: {err}");
    assert_eq!(store.discussion("taken"), before, "existing record must not be overwritten");
}

#[test]
fn new_discussion_fallback_derivation_is_unchanged() {
    // spec「衍生规则对照」Example 表：后备行为与本变更前逐比特一致。
    for (topic, want) in [
        ("Board Search", "board-search"),
        ("config context 与 rules GUI 编辑", "config-context-与-rules-gui-编辑"),
        ("看板 搜索列", "看板-搜索列"),
    ] {
        let store = TestStore::default();
        let info = super::new_discussion(&store, topic, None, None, None, &Default::default()).unwrap();
        assert_eq!(info.slug, want, "topic: {topic}");
        assert_eq!(info.topic, topic);
        assert!(store.read_live_discussion(want).is_some(), "file under derived slug");
    }
    // 纯 ASCII 标点主题衍生为空 → 报错。
    let store = TestStore::default();
    let err = super::new_discussion(&store, "!?!", None, None, None, &Default::default()).unwrap_err();
    assert!(err.to_string().contains("could not derive"), "err: {err}");
}

// --- discuss new：盖创建者章（spec「讨论记录盖创建者章」） ---

#[test]
fn new_discussion_stamps_created_by_when_identity_present() {
    let store = TestStore::default();
    let id = "Base Line <base@example.com>";
    let info = super::new_discussion(&store, "看板搜索列", Some("board-search-3"), Some(id), None, &Default::default()).unwrap();
    // frontmatter 盖 created_by、且 DiscussionInfo（→ --json createdBy）带同值。
    let text = store.read_live_discussion("board-search-3").expect("record stored");
    assert!(text.contains(&format!("created_by: {id}\n")), "frontmatter: {text}");
    assert_eq!(info.created_by.as_deref(), Some(id));
}

#[test]
fn new_discussion_omits_created_by_when_identity_absent() {
    let store = TestStore::default();
    let info = super::new_discussion(&store, "看板搜索列", Some("board-search-4"), None, None, &Default::default()).unwrap();
    // 无身分：frontmatter 不含 created_by、createdBy 缺席。
    let text = store.read_live_discussion("board-search-4").expect("record stored");
    assert!(!text.contains("created_by:"), "frontmatter should omit created_by: {text}");
    assert_eq!(info.created_by, None);
}

// --- restale flag：conclude 盖章 / seal 清除（reconclude-restale） ---

/// A promoted discussion (status: promoted, promoted_to set) with a written conclusion.
fn promoted_doc(slug: &str, topic: &str, promoted_to: &str, decision: &str) -> String {
    format!(
        "---\ntopic: {topic}\nslug: {slug}\nstatus: promoted\npromoted_to: {promoted_to}\ncreated: 2026-01-02\n---\n\n\
             # Discussion: {topic}\n\n\
             ## Context\n\nFixture context.\n\n\
             ## Rounds\n\n### Round 1 — assumptions (2026-01-02)\n\n**Focus**: scope\n\n\
             ## Conclusion\n\n**Decision**: {decision}\n"
    )
}

#[test]
fn conclude_stamps_restale_on_active_promoted_change() {
    let store =
        TestStore::with_live_discussion("alpha", &promoted_doc("alpha", "Alpha", "cut-a", "old"));
    store.metas.borrow_mut().insert(
        "cut-a".to_string(),
        "schema: spec-driven\nfrom_discussion: alpha\n".to_string(),
    );
    let flagged =
        super::conclude(&store, "alpha", "**Decision**: new direction", false).unwrap().restale_flagged;
    assert_eq!(flagged, vec!["cut-a".to_string()]);
    assert!(store.meta("cut-a").contains("restale_from: alpha"), "meta: {}", store.meta("cut-a"));
    // 讨论维持 promoted、promoted_to 不变，仅 Conclusion 改写。
    let disc = store.discussion("alpha");
    assert!(disc.contains("status: promoted\n"), "stays promoted: {disc}");
    assert!(disc.contains("promoted_to: cut-a\n"), "promoted_to intact: {disc}");
    assert!(disc.contains("**Decision**: new direction"), "conclusion rewritten: {disc}");
}

#[test]
fn conclude_restale_skips_archived_change() {
    // promoted_to 同含 active 与已归档变更；仅 active 被盖。
    let store = TestStore::with_live_discussion(
        "alpha",
        &promoted_doc("alpha", "Alpha", "cut-a, arch-b", "old"),
    );
    store.metas.borrow_mut().insert("cut-a".to_string(), "schema: spec-driven\n".to_string());
    // arch-b 仅存于封存（read_change_meta 回 None）——非 active。
    store
        .archived_metas
        .borrow_mut()
        .insert("arch-b".to_string(), "schema: spec-driven\n".to_string());
    let flagged = super::conclude(&store, "alpha", "**Decision**: new", false).unwrap().restale_flagged;
    assert_eq!(flagged, vec!["cut-a".to_string()], "only active flagged");
    assert!(store.meta("cut-a").contains("restale_from: alpha"));
    assert!(!store.change_exists("arch-b"), "archived never active");
    assert_eq!(
        store.archived_metas.borrow().get("arch-b").unwrap(),
        "schema: spec-driven\n",
        "archived meta untouched"
    );
}

#[test]
fn conclude_restale_skips_corrupt_meta_change_without_writing() {
    // fail-closed 扫尾：promoted_to 指向的 change metadata 损坏时跳过该卡
    // （沿 archived/gone 的 skip 原则——单一坏档不得使 conclude 中止），
    // 坏档逐比特不变、其余 active change 照常盖章。
    const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
    let store = TestStore::with_live_discussion(
        "alpha",
        &promoted_doc("alpha", "Alpha", "cut-a, broken-b", "old"),
    );
    store.metas.borrow_mut().insert("cut-a".to_string(), "schema: spec-driven\n".to_string());
    store.metas.borrow_mut().insert("broken-b".to_string(), BAD.to_string());
    let flagged = super::conclude(&store, "alpha", "**Decision**: new", false).unwrap().restale_flagged;
    assert_eq!(flagged, vec!["cut-a".to_string()], "corrupt change is not flagged");
    assert!(store.meta("cut-a").contains("restale_from: alpha"));
    assert_eq!(store.meta("broken-b"), BAD, "corrupt meta must not be appended to");
}

#[test]
fn conclude_promoted_to_empty_stamps_nothing() {
    // concluded-but-not-promoted：promoted_to 缺席 → 不盖章。
    let store =
        TestStore::with_live_discussion("alpha", &concluded_doc("alpha", "Alpha", "old"));
    store.metas.borrow_mut().insert("cut-a".to_string(), "schema: spec-driven\n".to_string());
    let flagged = super::conclude(&store, "alpha", "**Decision**: new", false).unwrap().restale_flagged;
    assert!(flagged.is_empty());
    assert_eq!(*store.meta_writes.borrow(), 0, "no change meta written");
    assert_eq!(store.meta("cut-a"), "schema: spec-driven\n", "change meta untouched");
}

#[test]
fn conclude_restale_stamp_is_idempotent() {
    let store =
        TestStore::with_live_discussion("alpha", &promoted_doc("alpha", "Alpha", "cut-a", "old"));
    store.metas.borrow_mut().insert(
        "cut-a".to_string(),
        "schema: spec-driven\nrestale_from: alpha\n".to_string(),
    );
    let before = store.meta("cut-a");
    let flagged =
        super::conclude(&store, "alpha", "**Decision**: newer", false).unwrap().restale_flagged;
    assert_eq!(flagged, vec!["cut-a".to_string()], "still reported stale");
    assert_eq!(store.meta("cut-a"), before, "no duplicate accumulation");
    assert_eq!(*store.meta_writes.borrow(), 0, "idempotent — no change meta write");
}

#[test]
fn seal_clears_restale_slug_keeping_others() {
    let store =
        TestStore::with_live_discussion("alpha", &concluded_doc("alpha", "Alpha", "done"));
    store.metas.borrow_mut().insert(
        "cut-a".to_string(),
        "schema: spec-driven\nfrom_discussion: alpha\nrestale_from: alpha, beta\n".to_string(),
    );
    super::seal(&store, "alpha", "cut-a", false).unwrap();
    let meta = store.meta("cut-a");
    assert!(meta.contains("restale_from: beta\n"), "alpha cleared, beta kept: {meta}");
    assert!(!meta.contains("restale_from: alpha"), "alpha gone: {meta}");
    assert!(store.discussion("alpha").contains("status: promoted\n"), "sealed → promoted");
}

#[test]
fn seal_clears_restale_line_when_last_slug() {
    let store =
        TestStore::with_live_discussion("alpha", &concluded_doc("alpha", "Alpha", "done"));
    store.metas.borrow_mut().insert(
        "cut-a".to_string(),
        "schema: spec-driven\nfrom_discussion: alpha\nrestale_from: alpha\n".to_string(),
    );
    super::seal(&store, "alpha", "cut-a", false).unwrap();
    let meta = store.meta("cut-a");
    assert!(!meta.contains("restale_from"), "restale_from line dropped: {meta}");
    assert!(meta.contains("from_discussion: alpha\n"), "other fields intact: {meta}");
}

#[test]
fn seal_restale_clear_is_noop_when_absent() {
    let store =
        TestStore::with_live_discussion("alpha", &concluded_doc("alpha", "Alpha", "done"));
    store.metas.borrow_mut().insert(
        "cut-a".to_string(),
        "schema: spec-driven\nfrom_discussion: alpha\n".to_string(),
    );
    super::seal(&store, "alpha", "cut-a", false).unwrap();
    assert!(!store.meta("cut-a").contains("restale_from"), "no restale_from introduced");
}

// --- kind 标记（add-improve-flow；规格「讨论记录以 --kind 标记改进讨论」） ---

#[test]
fn new_discussion_with_kind_writes_frontmatter_and_reports_it() {
    let store = TestStore::default();
    let info =
        super::new_discussion(&store, "内核结构改进", Some("improve-core"), None, Some("improve"), &Default::default())
            .unwrap();
    assert_eq!(info.kind.as_deref(), Some("improve"));
    let text = store.discussion("improve-core");
    assert!(text.contains("\nkind: improve\n"), "frontmatter 应含 kind: {text}");
}

#[test]
fn new_discussion_rejects_kind_outside_the_whitelist_without_writing() {
    for bad in ["refactor", "IMPROVE", "", "improve\nstatus: forged"] {
        let store = TestStore::default();
        let err = super::new_discussion(&store, "主题", Some("alpha"), None, Some(bad), &Default::default())
            .expect_err("非白名单 kind 必须拒绝")
            .to_string();
        assert!(err.contains("improve"), "消息须说明仅接受 improve：{err}");
        assert!(store.discussions.borrow().is_empty(), "拒绝时不得落档（kind={bad:?}）");
    }
}

#[test]
fn new_discussion_without_kind_leaves_frontmatter_unchanged() {
    let store = TestStore::default();
    let info = super::new_discussion(&store, "主题", Some("alpha"), None, None, &Default::default()).unwrap();
    assert!(info.kind.is_none(), "无 kind 时字段缺席");
    assert!(!store.discussion("alpha").contains("kind:"), "不得写入 kind 行");
}

#[test]
fn new_discussion_rejects_multiline_topic_without_writing() {
    // topic 逐字写入 frontmatter——夹带换行可注入伪造的 kind:/status: 行
    // （读端取第一个命中），必须在系统边界挡下。
    for bad in ["x\nkind: improve\nstatus: promoted", "x\rkind: improve", "x\r\ny"] {
        let store = TestStore::default();
        let err = super::new_discussion(&store, bad, Some("plain-a"), None, None, &Default::default())
            .expect_err("多行 topic 必须拒绝")
            .to_string();
        assert!(err.contains("invalid topic"), "消息须点名 topic：{err}");
        assert!(store.discussions.borrow().is_empty(), "拒绝时不得落档（topic={bad:?}）");
    }
}

#[test]
fn empty_kind_frontmatter_reads_as_plain() {
    // 手改记录写出空值 `kind:` 不得让 payload 冒出 "kind": ""——
    // 读取端范式为缺席，维持「缺席即省略」的形状不变量。
    let doc = open_doc("gamma", "Gamma").replacen("status: open\n", "status: open\nkind:\n", 1);
    let store = TestStore::with_live_discussion("gamma", &doc);
    assert!(super::info(&store, "gamma").unwrap().kind.is_none(), "空值 kind 视为一般讨论");
}

#[test]
fn kind_is_read_from_frontmatter_and_absent_records_are_plain() {
    let plain = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    assert!(super::info(&plain, "alpha").unwrap().kind.is_none(), "旧记录视为一般讨论");

    let marked = open_doc("beta", "Beta")
        .replacen("status: open\n", "status: open\nkind: improve\n", 1);
    let store = TestStore::with_live_discussion("beta", &marked);
    // info 与 list 共用 info_from_doc；list 面的曝露由 CLI 集成测试把关
    // （TestStore 不供列表）。
    assert_eq!(super::info(&store, "beta").unwrap().kind.as_deref(), Some("improve"));
}

// --- 结构锚定与撞名内容跳脱（fix-discuss-section-anchor） ---

#[test]
fn add_round_appends_after_prior_round_with_level2_content_line() {
    // spec Example「两轮顺序与内文归属」：Round 1 内文含「## 背景」行，
    // add_round 追加 Round 2 仍落在 Round 1 完整内文之后、结构 Conclusion 之前；
    // 「## 背景」不撞结构、维持原样。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    super::add_round(&store, "alpha", "explore", "## 背景\n首轮本文").unwrap();
    super::add_round(&store, "alpha", "explore", "次轮本文").unwrap();
    let text = store.discussion("alpha");
    let pos = |needle: &str| {
        text.find(needle).unwrap_or_else(|| panic!("missing {needle:?} in: {text}"))
    };
    let round1 = pos("### Round 1");
    let bg = pos("## 背景");
    let first = pos("首轮本文");
    let round2 = pos("### Round 2");
    let second = pos("次轮本文");
    let conclusion = pos("## Conclusion");
    assert!(
        round1 < bg && bg < first && first < round2 && round2 < second && second < conclusion,
        "文档顺序须为 Round 1 标题→Round 1 完整内文→Round 2 标题→Round 2 内文→结构 Conclusion: {text}"
    );
}

#[test]
fn conclude_lands_in_structural_conclusion_when_round_content_collides() {
    // spec「结论写入不落入轮内」：轮内文原始输入含整行「## Conclusion」→
    // 落盘即跳脱；conclude 后结论写入结构 Conclusion 区段、既有轮内文不被改写。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    super::add_round(&store, "alpha", "explore", "伪结论引子\n## Conclusion\n伪结论本文")
        .unwrap();
    assert!(
        store.discussion("alpha").contains("\\## Conclusion"),
        "add_round 落盘前须跳脱撞名行: {}",
        store.discussion("alpha")
    );
    super::conclude(&store, "alpha", "**Decision**: real", false).unwrap();
    let text = store.discussion("alpha");
    assert!(
        text.contains("伪结论引子\n\\## Conclusion\n伪结论本文"),
        "既有轮内文（含跳脱行）不得被 conclude 改写: {text}"
    );
    let header = text.find("\n## Conclusion\n").expect("structural header");
    let fake_body = text.find("伪结论本文").unwrap();
    let decision = text.find("**Decision**: real").expect("conclusion written");
    assert!(
        fake_body < header && header < decision,
        "结论须写入结构 Conclusion 区段（于轮内文之后）: {text}"
    );
    assert_eq!(
        super::conclusion_text(&store, "alpha").as_deref(),
        Some("**Decision**: real"),
        "conclusion_text 须读到结构区段的结论"
    );
}

#[test]
fn count_rounds_ignores_colliding_content_and_numbering_stays_consecutive() {
    // spec「撞名轮标题行不膨胀轮计数」：内文行首「### Round 」跳脱落盘，
    // 计数不膨胀、下一轮编号连续。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    super::add_round(&store, "alpha", "explore", "### Round 99 — fake (2026-01-01)\n本文")
        .unwrap();
    assert_eq!(super::count_rounds(&store.discussion("alpha")), 1, "撞名行不得计数");
    let no = super::add_round(&store, "alpha", "explore", "次轮").unwrap();
    assert_eq!(no, 2, "编号须连续、无跳号");
    // list/info 的 rounds 字段走同一 count_rounds 链路。
    assert_eq!(super::info(&store, "alpha").unwrap().rounds, 2, "discuss list 轮数同合法计数");
    // 手改记录的非法轮标题形状（无编号）不计数；pre-scaffold「## Round 」照旧容忍。
    let legacy = "## Rounds\n\n### Round 备注不是轮\n\n## Round 1 — old (2026-01-01)\n";
    assert_eq!(super::count_rounds(legacy), 1);
}

#[test]
fn set_context_preserves_pre_scaffold_rounds() {
    // pre-scaffold 版面（有 ## Context、无 ## Rounds/## Conclusion）上
    // set_context 只得替换脉络本文，其后的 level-2 轮区段不得被覆写。
    let doc = "---\ntopic: Legacy\nslug: legacy\nstatus: open\ncreated: 2026-01-02\n---\n\n\
                   # Discussion: Legacy\n\n\
                   ## Context\n\n旧脉络。\n\n\
                   ## Round 1 — assumptions (2026-01-02)\n\n首轮本文\n";
    let store = TestStore::with_live_discussion("legacy", doc);
    super::set_context(&store, "legacy", "新脉络").unwrap();
    let text = store.discussion("legacy");
    assert!(text.contains("新脉络"), "text: {text}");
    assert!(
        text.contains("## Round 1 — assumptions (2026-01-02)\n\n首轮本文"),
        "pre-scaffold 轮不得被覆写: {text}"
    );
}

#[test]
fn conclusion_boundary_stops_at_pre_scaffold_round() {
    // pre-scaffold 上 conclude 之后追加的 ## Round 区段——结论读取不吞、
    // re-conclude 不删。
    let doc = "---\ntopic: Legacy\nslug: legacy\nstatus: concluded\ncreated: 2026-01-02\n---\n\n\
                   # Discussion: Legacy\n\n\
                   ## Context\n\n脉络。\n\n\
                   ## Conclusion\n\n**Decision**: done\n\n\
                   ## Round 2 — explore (2026-01-03)\n\n次轮本文\n";
    let store = TestStore::with_live_discussion("legacy", doc);
    assert_eq!(
        super::conclusion_text(&store, "legacy").as_deref(),
        Some("**Decision**: done"),
        "结论读取不得吞掉其后的轮区段"
    );
    super::conclude(&store, "legacy", "**Decision**: revised", false).unwrap();
    let text = store.discussion("legacy");
    assert!(
        text.contains("## Round 2 — explore (2026-01-03)\n\n次轮本文"),
        "re-conclude 不得删除其后的轮区段: {text}"
    );
    assert_eq!(
        super::conclusion_text(&store, "legacy").as_deref(),
        Some("**Decision**: revised")
    );
}

#[test]
fn discard_refuses_on_malformed_round_heading() {
    // 手改坏形状（ASCII 连字号）仍是「有轮」的证据——保护面宽松侦测，
    // 不因计数收紧而放行无 --force 的删除。
    let doc = open_doc("alpha", "Alpha").replacen(
        "## Rounds\n",
        "## Rounds\n\n### Round 1 - broken (2026-01-02)\n\n首轮本文\n",
        1,
    );
    let store = TestStore::with_live_discussion("alpha", &doc);
    assert!(super::discard_discussion(&store, "alpha", false).is_err(), "坏形状轮仍须挡删");
    assert_eq!(store.discussion("alpha"), doc, "拒绝时不得删档");
}

#[test]
fn fenced_layout_quotes_are_not_escaped_and_not_structure() {
    // ``` 围栏内引用文档版面——不跳脱、不计数、不作区段边界。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    let quoted = "示范版面：\n```\n## Conclusion\n### Round 9 — fake (2026-01-01)\n```\n收尾";
    super::add_round(&store, "alpha", "explore", quoted).unwrap();
    let text = store.discussion("alpha");
    assert!(
        text.contains("```\n## Conclusion\n### Round 9 — fake (2026-01-01)\n```"),
        "围栏内不得跳脱: {text}"
    );
    assert_eq!(super::count_rounds(&text), 1, "围栏内轮标题不计数");
    super::conclude(&store, "alpha", "**Decision**: real", false).unwrap();
    let text = store.discussion("alpha");
    assert!(text.contains("```\n## Conclusion\n"), "围栏内容不被 conclude 改写: {text}");
    assert_eq!(
        super::conclusion_text(&store, "alpha").as_deref(),
        Some("**Decision**: real"),
        "结论读取须锚定结构区段"
    );
}

#[test]
fn scaffold_round_heading_shape_matches_ui_parser() {
    // 引擎轮标题判准与 UI splitRounds 同形——`<mode> (<date>)` 缺一不可。
    assert!(super::is_scaffold_round_heading("### Round 1 — assumptions (2026-01-02)"));
    assert!(super::is_scaffold_round_heading("### Round 12 — grill (2026-12-31)"));
    for bad in [
        "### Round 1 — mode",              // 缺日期括号
        "### Round 1 — (2026-01-02)",      // 缺 mode
        "### Round — mode (2026-01-02)",   // 缺编号
        "### Round 1 - mode (2026-01-02)", // ASCII 连字号
    ] {
        assert!(!super::is_scaffold_round_heading(bad), "{bad:?} 不是合法轮标题");
    }
}

#[test]
fn unbalanced_fence_is_escaped_at_write_so_structure_stays_sound() {
    // 写入边界强制围栏成对：落单的围栏行跳脱，其后全文的结构解析不受污染。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    super::add_round(&store, "alpha", "explore", "前文\n```\n没有关闭的引用").unwrap();
    let text = store.discussion("alpha");
    assert!(text.contains("前文\n\\```\n没有关闭的引用"), "落单围栏行须跳脱: {text}");
    let no = super::add_round(&store, "alpha", "explore", "次轮本文").unwrap();
    assert_eq!(no, 2, "围栏状态不得外溢到计数");
    let text = store.discussion("alpha");
    let r2 = text.find("### Round 2").unwrap();
    let conc = text.find("\n## Conclusion\n").unwrap();
    assert!(r2 < conc, "新轮仍须落在结构 Conclusion 之前: {text}");
    super::conclude(&store, "alpha", "**Decision**: real", false).unwrap();
    let text = store.discussion("alpha");
    assert_eq!(
        super::conclusion_text(&store, "alpha").as_deref(),
        Some("**Decision**: real"),
        "conclude 不得误走 pre-scaffold 后备: {text}"
    );
    assert_eq!(text.matches("## Conclusion").count(), 1, "不得追加第二个 Conclusion: {text}");
}

#[test]
fn discard_ignores_fenced_round_quotes() {
    // 零轮讨论的 Context 围栏引用轮标题——不得挡下 discard。
    let doc = open_doc("alpha", "Alpha").replacen(
        "## Context\n\nFixture context.\n",
        "## Context\n\n```\n### Round 1 — quoted (2026-01-02)\n```\n",
        1,
    );
    let store = TestStore::with_live_discussion("alpha", &doc);
    super::discard_discussion(&store, "alpha", false).unwrap();
    assert!(store.read_live_discussion("alpha").is_none(), "零轮记录应可直接删除");
}

#[test]
fn set_context_escapes_colliding_lines() {
    // 三个写入动词的跳脱——set_context 面的直接测试。
    let store = TestStore::with_live_discussion("alpha", &open_doc("alpha", "Alpha"));
    super::set_context(&store, "alpha", "引子\n## Rounds\n### Round 3 — fake (2026-01-01)")
        .unwrap();
    let text = store.discussion("alpha");
    assert!(
        text.contains("引子\n\\## Rounds\n\\### Round 3 — fake (2026-01-01)"),
        "text: {text}"
    );
    assert_eq!(super::count_rounds(&text), 0);
}

// --- discuss search（discuss-search-recall）---

/// A scaffolded record whose Rounds and Conclusion bodies are the caller's.
fn search_doc(slug: &str, topic: &str, created: &str, rounds: &str, conclusion: &str) -> String {
    format!(
        "---\ntopic: {topic}\nslug: {slug}\nstatus: open\ncreated: {created}\n---\n\n\
             # Discussion: {topic}\n\n\
             ## Context\n\nFixture context.\n\n\
             ## Rounds\n\n{rounds}\n\
             ## Conclusion\n\n{conclusion}\n"
    )
}

fn terms(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn kinds(hit: &super::DiscussionHit) -> Vec<(&str, &str)> {
    hit.matches.iter().map(|m| (m.kind.as_str(), m.where_.as_str())).collect()
}

#[test]
fn search_hits_topic_as_frontmatter() {
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Golden snapshot policy", "2026-07-01", "", ""),
    );
    let hits = super::search(&store, &terms(&["golden"])).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].info.slug, "alpha");
    assert!(!hits[0].info.archived);
    assert_eq!(kinds(&hits[0]), [("topic", "frontmatter")]);
    assert_eq!(hits[0].matches[0].text, "Golden snapshot policy");
}

#[test]
fn search_hits_slug_as_frontmatter() {
    let store = TestStore::with_live_discussion(
        "sse-transport",
        &search_doc("sse-transport", "Transport choice", "2026-07-01", "", ""),
    );
    let hits = super::search(&store, &terms(&["sse"])).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(kinds(&hits[0]), [("slug", "frontmatter")]);
    assert_eq!(hits[0].matches[0].text, "sse-transport");
}

#[test]
fn search_hits_ruled_out_line_with_its_round_number_in_archived_record() {
    let rounds = "### Round 1 — assumptions (2026-07-01)\n\n**Focus**: scope\n**Ruled out**: nothing yet\n\n\
                      ### Round 2 — interview (2026-07-02)\n\n**Focus**: drawer\n\
                      **Ruled out**: RichDetailDrawer 加 readOnly 旗标（分支地狱）\n";
    let store = TestStore::default();
    store.archived_discussions.borrow_mut().insert(
        "spec-drawer-trace-links".into(),
        search_doc("spec-drawer-trace-links", "Trace links", "2026-07-01", rounds, "**Decision**: two hops\n"),
    );
    let hits = super::search(&store, &terms(&["drawer"])).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].info.archived, "archived records are searched by default");
    // Focus 行不算；slug 命中排前、ruled-out 行在后（文档顺序）。
    assert_eq!(kinds(&hits[0]), [("slug", "frontmatter"), ("ruled-out", "round-2")]);
    assert_eq!(hits[0].matches[1].text, "**Ruled out**: RichDetailDrawer 加 readOnly 旗标（分支地狱）");
}

#[test]
fn search_hits_the_three_conclusion_decision_lines() {
    let conclusion = "**Decision**: drawer stays read-only\n\
                          **Rejected alternatives**: drawer readOnly flag\n\
                          **Deferred**: drawer AND mode\n\
                          Prose mentioning drawer does not count.\n";
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Alpha", "2026-07-01", "", conclusion),
    );
    let hits = super::search(&store, &terms(&["drawer"])).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(
        kinds(&hits[0]),
        [("decision", "conclusion"), ("rejected", "conclusion"), ("deferred", "conclusion")]
    );
    assert_eq!(hits[0].matches[0].text, "**Decision**: drawer stays read-only");
}

#[test]
fn search_is_case_insensitive() {
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "SSE transport", "2026-07-01", "", "**Deferred**: Golden regen\n"),
    );
    let hits = super::search(&store, &terms(&["sse"])).unwrap();
    assert_eq!(kinds(&hits[0]), [("topic", "frontmatter")]);
    let hits = super::search(&store, &terms(&["GOLDEN"])).unwrap();
    assert_eq!(kinds(&hits[0]), [("deferred", "conclusion")]);
}

#[test]
fn search_matches_any_of_several_terms() {
    let store = TestStore::with_live_discussion(
        "a",
        &search_doc("a", "Golden policy", "2026-07-01", "", ""),
    );
    store.discussions.borrow_mut().insert(
        "b".into(),
        search_doc("b", "Transport", "2026-08-01", "", "**Deferred**: SSE reconnect\n"),
    );
    let hits = super::search(&store, &terms(&["golden", "sse"])).unwrap();
    let slugs: Vec<&str> = hits.iter().map(|h| h.info.slug.as_str()).collect();
    assert_eq!(slugs, ["a", "b"]);
}

#[test]
fn search_ignores_evidence_and_other_non_decision_lines() {
    let rounds = "### Round 1 — interview (2026-07-01)\n\n**Focus**: sidecar\n**Position**: sidecar first\n\
                      **Evidence**: see sidecar.rs\n**Open**: sidecar naming\n\nProse about sidecar.\n";
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Alpha", "2026-07-01", rounds, "Free text about sidecar.\n"),
    );
    let hits = super::search(&store, &terms(&["sidecar"])).unwrap();
    assert!(hits.is_empty(), "only decision lines count: {hits:?}");
}

#[test]
fn search_tolerates_records_without_rounds_or_conclusion() {
    // 只有 frontmatter 与 Context：仍以 topic 参与比对。
    let bare = "---\ntopic: Drawer scope\nslug: bare\nstatus: open\ncreated: 2026-07-01\n---\n\n\
                    # Discussion: Drawer scope\n\n## Context\n\nseed\n";
    let store = TestStore::with_live_discussion("bare", bare);
    // 有 Ruled out 行但没有任何轮标题：该行不算决定行，topic 仍命中。
    store.discussions.borrow_mut().insert(
        "headless".into(),
        "---\ntopic: Drawer again\nslug: headless\nstatus: open\ncreated: 2026-06-01\n---\n\n\
             ## Rounds\n\n**Ruled out**: drawer flag\n"
            .into(),
    );
    let hits = super::search(&store, &terms(&["drawer"])).unwrap();
    assert_eq!(hits.len(), 2);
    for hit in &hits {
        assert_eq!(kinds(hit), [("topic", "frontmatter")], "slug {}", hit.info.slug);
    }
}

#[test]
fn search_rejects_an_empty_or_blank_term_list() {
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Alpha", "2026-07-01", "", ""),
    );
    assert!(super::search(&store, &[]).is_err());
    assert!(super::search(&store, &terms(&["  ", ""])).is_err());
}

#[test]
fn search_orders_frontmatter_hits_first_then_created_newest_first() {
    // spec「讨论定案以 search 动词可查」的排序表：A topic → C slug → B conclusion → D round。
    let store = TestStore::default();
    let mut docs = store.discussions.borrow_mut();
    docs.insert("a".into(), search_doc("a", "Golden policy", "2026-07-01", "", ""));
    docs.insert("golden-regen".into(), search_doc("golden-regen", "Regen", "2026-06-01", "", ""));
    docs.insert("b".into(), search_doc("b", "B", "2026-08-01", "", "**Deferred**: golden later\n"));
    docs.insert(
        "d".into(),
        search_doc(
            "d",
            "D",
            "2026-05-01",
            "### Round 1 — interview (2026-05-01)\n\n**Ruled out**: golden inline\n",
            "",
        ),
    );
    drop(docs);
    let hits = super::search(&store, &terms(&["golden"])).unwrap();
    let slugs: Vec<&str> = hits.iter().map(|h| h.info.slug.as_str()).collect();
    assert_eq!(slugs, ["a", "golden-regen", "b", "d"]);
    assert_eq!(kinds(&hits[3]), [("ruled-out", "round-1")]);
}

#[test]
fn search_breaks_same_day_ties_by_slug() {
    let store = TestStore::default();
    let mut docs = store.discussions.borrow_mut();
    docs.insert("zeta".into(), search_doc("zeta", "Golden Z", "2026-07-01", "", ""));
    docs.insert("alpha".into(), search_doc("alpha", "Golden A", "2026-07-01", "", ""));
    docs.insert("mid".into(), search_doc("mid", "M", "2026-07-01", "", "**Decision**: golden\n"));
    docs.insert("late".into(), search_doc("late", "L", "2026-07-02", "", "**Decision**: golden\n"));
    drop(docs);
    let hits = super::search(&store, &terms(&["golden"])).unwrap();
    let slugs: Vec<&str> = hits.iter().map(|h| h.info.slug.as_str()).collect();
    assert_eq!(slugs, ["alpha", "zeta", "late", "mid"]);
}

#[test]
fn search_hit_serializes_as_info_fields_plus_matches() {
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Golden", "2026-07-01", "", "**Deferred**: golden regen\n"),
    );
    let hits = super::search(&store, &terms(&["golden"])).unwrap();
    let v = serde_json::to_value(&hits[0]).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["archived", "created", "matches", "path", "rounds", "slug", "status", "topic"],
        "the list payload's fields flattened, plus matches"
    );
    let m = &v["matches"][1];
    let mut mkeys: Vec<&str> = m.as_object().unwrap().keys().map(String::as_str).collect();
    mkeys.sort_unstable();
    assert_eq!(mkeys, ["kind", "text", "where"]);
    assert_eq!(m["where"], "conclusion");
    assert_eq!(m["kind"], "deferred");
}

#[test]
fn search_splits_each_term_on_whitespace_like_the_server_does() {
    // design D4／Non-Goals：关键字含空白不支持——CLI 位置参数与 server 的 q 皆以空白切词。
    // 引擎统一切词，让带引号的多字参数在本机与 remote 得到同一组命中。
    let store = TestStore::with_live_discussion(
        "a",
        &search_doc("a", "Golden policy", "2026-07-01", "", ""),
    );
    store.discussions.borrow_mut().insert(
        "b".into(),
        search_doc("b", "Transport", "2026-08-01", "", "**Deferred**: SSE reconnect\n"),
    );
    let hits = super::search(&store, &terms(&["golden  sse"])).unwrap();
    let slugs: Vec<&str> = hits.iter().map(|h| h.info.slug.as_str()).collect();
    assert_eq!(slugs, ["a", "b"], "one quoted argument behaves as two keywords");
}

#[test]
fn search_hits_list_item_lines_that_continue_a_decision_marker() {
    // review 第一轮 must-fix：封存记录惯用「标记独占一行、内容写在下一行条列」。
    // 标记行之后紧接的条列行都算该决定行的一部分；散文与下一个标记不算。
    let rounds = "### Round 1 — interview (2026-07-01)\n\n**Focus**: x\n\
                      **Ruled out**:\n- 只在 tray.ts 修落页\n- 把 drawer 拿掉\n\n\
                      **Open**: drawer naming\n";
    let conclusion = "**Decision**: 两件事：\n- keep drawer\n- ship\n\n\
                          **Deferred**:\n- drawer AND mode\nProse mentioning drawer.\n";
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Alpha", "2026-07-01", rounds, conclusion),
    );
    let hits = super::search(&store, &terms(&["drawer"])).unwrap();
    assert_eq!(hits.len(), 1);
    let got: Vec<(&str, &str, &str)> = hits[0]
        .matches
        .iter()
        .map(|m| (m.kind.as_str(), m.where_.as_str(), m.text.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            ("ruled-out", "round-1", "- 把 drawer 拿掉"),
            ("decision", "conclusion", "- keep drawer"),
            ("deferred", "conclusion", "- drawer AND mode"),
        ]
    );
}

#[test]
fn search_reads_structure_like_the_rest_of_the_parser() {
    // review 第一轮：缩进的轮标题／结构标题其他解析器不认，搜索也不认。
    let rounds = "### Round 1 — interview (2026-07-01)\n\n**Ruled out**: drawer a\n\n\
                      \x20 ### Round 2 — interview (2026-07-02)\n\n**Ruled out**: drawer b\n\n\
                      \x20 ## Conclusion\n\n**Decision**: drawer c\n";
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Alpha", "2026-07-01", rounds, ""),
    );
    let hits = super::search(&store, &terms(&["drawer"])).unwrap();
    assert_eq!(
        kinds(&hits[0]),
        [("ruled-out", "round-1"), ("ruled-out", "round-1")],
        "an indented heading is content: both lines stay in round 1 and no conclusion opens"
    );
}

#[test]
fn search_drops_round_attribution_after_a_malformed_round_heading() {
    // review 第一轮：坏形状轮标题 count_rounds 不算轮，搜索也不把其下的行挂到上一轮。
    let rounds = "### Round 1 — interview (2026-07-01)\n\n**Ruled out**: golden a\n\n\
                      ### Round 3\n\n**Ruled out**: golden b\n";
    let store = TestStore::with_live_discussion(
        "alpha",
        &search_doc("alpha", "Alpha", "2026-07-01", rounds, ""),
    );
    let hits = super::search(&store, &terms(&["golden"])).unwrap();
    assert_eq!(kinds(&hits[0]), [("ruled-out", "round-1")]);
    assert_eq!(hits[0].matches[0].text, "**Ruled out**: golden a");
}

// --- DiscussionHead（lifecycle-discussion-head design D3／D4）---

use super::{DiscussionHead, Status};

/// 内文引用 `status: open` 与 `status: concluded` 字符串的已结论记录——本 change
/// 立案时对 improve-lifecycle-layer 发作的案例。
fn body_quoting_status_doc() -> String {
    "---\ntopic: Lifecycle\nslug: improve-lifecycle-layer\nstatus: concluded\ncreated: 2026-09-01\n---\n\n\
         # Discussion: Lifecycle\n\n\
         ## Context\n\n候选 1：`replacen(\"status: open\")` 不限于 frontmatter；`status: concluded` 也一样。\n\n\
         ## Conclusion\n\n**Decision**: three cuts\n"
        .to_string()
}

#[test]
fn head_parse_without_frontmatter_yields_defaults_and_no_write_back() {
    let head = DiscussionHead::parse("# Discussion: bare\n\n## Rounds\n");
    assert_eq!(head.slug, None);
    assert_eq!(head.topic, None);
    assert_eq!(head.status, Status::Open);
    assert_eq!(head.created, None);
    assert_eq!(head.created_by, None);
    assert_eq!(head.kind, None);
    assert!(head.promoted_to.is_empty());
    assert!(!head.hold);
    assert_eq!(head.board_rank, None);
    assert_eq!(head.write_back().unwrap(), None);
    // 写入方法照常可调用，只是无处回写。
    let mut head = head;
    head.conclude(true);
    assert_eq!(head.write_back().unwrap(), None);
}

#[test]
fn head_parse_reads_every_field_and_normalizes_empties() {
    let text = "---\ntopic: Alpha search\nslug: alpha\nstatus: promoted\npromoted_to: cut-a, cut-b\n\
                    created: 2026-01-02\ncreated_by: Ann <ann@x.io>\nkind:\nboard_rank:\nhold: true\n---\n\nbody\n";
    let head = DiscussionHead::parse(text);
    assert_eq!(head.slug.as_deref(), Some("alpha"));
    assert_eq!(head.topic.as_deref(), Some("Alpha search"));
    assert_eq!(head.status, Status::Promoted);
    assert_eq!(head.promoted_to, vec!["cut-a", "cut-b"]);
    assert_eq!(head.created.as_deref(), Some("2026-01-02"));
    assert_eq!(head.created_by.as_deref(), Some("Ann <ann@x.io>"));
    assert_eq!(head.kind, None, "空值 kind 范式为缺席");
    assert_eq!(head.board_rank, None, "空值 board_rank 范式为缺席");
    assert!(head.hold);
    // 只有字面 true 算 hold。
    assert!(!DiscussionHead::parse("---\nhold: yes\n---\n").hold);
    // 未改动的 head 回写逐比特不变。
    assert_eq!(head.write_back().unwrap().as_deref(), Some(text));
}

#[test]
fn head_status_defaults_to_open_and_keeps_an_unknown_literal() {
    assert_eq!(DiscussionHead::parse("---\nslug: x\n---\n").status, Status::Open);
    assert_eq!(DiscussionHead::parse("---\nstatus: open\n---\n").status, Status::Open);
    assert_eq!(DiscussionHead::parse("---\nstatus: concluded\n---\n").status, Status::Concluded);
    let head = DiscussionHead::parse("---\nstatus: Parked!\n---\n");
    assert_eq!(head.status, Status::Unknown("Parked!".into()));
    assert_eq!(head.status.as_str(), "Parked!", "投影逐比特回原字符串");
    assert_eq!(head.write_back().unwrap().as_deref(), Some("---\nstatus: Parked!\n---\n"));
}

#[test]
fn head_promote_new_change_keeps_hold_and_returns_true() {
    let mut head = DiscussionHead::parse(&held_promoted_doc("alpha", "cut-a"));
    assert!(head.promote("cut-b", false));
    assert_eq!(head.status, Status::Promoted);
    assert_eq!(head.promoted_to, vec!["cut-a", "cut-b"]);
    assert!(head.hold);
    let text = head.write_back().unwrap().unwrap();
    assert!(text.contains("promoted_to: cut-a, cut-b\n"));
    assert!(text.contains("hold: true\n"), "旗标行逐字保留: {text}");
}

#[test]
fn head_promote_known_change_keeps_hold_and_returns_false() {
    let doc = held_promoted_doc("alpha", "cut-a");
    let mut head = DiscussionHead::parse(&doc);
    assert!(!head.promote("cut-a", false));
    assert!(head.hold, "没有新刀累加，旗标保留");
    assert_eq!(head.write_back().unwrap().as_deref(), Some(doc.as_str()), "幂等：逐比特不变");
}

#[test]
fn head_promote_from_open_concluded_and_unknown_becomes_promoted() {
    for status in ["open", "concluded", "parked"] {
        let mut head = DiscussionHead::parse(&format!("---\nstatus: {status}\n---\n"));
        assert!(head.promote("cut", false));
        assert_eq!(head.status, Status::Promoted, "from {status}");
        assert_eq!(head.write_back().unwrap().as_deref(), Some("---\nstatus: promoted\npromoted_to: cut\n---\n"));
    }
}

#[test]
fn head_promote_touches_only_the_frontmatter_when_the_body_quotes_status_strings() {
    let doc = body_quoting_status_doc();
    let mut head = DiscussionHead::parse(&doc);
    assert!(head.promote("lifecycle-discussion-head", false));
    let text = head.write_back().unwrap().unwrap();
    let (fm, body) = text.split_once("\n---\n").unwrap();
    let (_, original_body) = doc.split_once("\n---\n").unwrap();
    assert_eq!(body, original_body, "内文逐比特不变");
    assert_eq!(
        fm,
        "---\ntopic: Lifecycle\nslug: improve-lifecycle-layer\nstatus: promoted\ncreated: 2026-09-01\npromoted_to: lifecycle-discussion-head",
        "新行补在 frontmatter 尾端（closing --- 前）"
    );
}

#[test]
fn head_unlink_returns_none_when_the_change_is_not_listed() {
    let doc = promoted_doc("alpha", "Alpha", "cut-a", "x");
    let mut head = DiscussionHead::parse(&doc);
    assert_eq!(head.unlink("cut-z", true), None);
    assert_eq!(head.write_back().unwrap().as_deref(), Some(doc.as_str()));
    let mut head = DiscussionHead::parse(&open_doc("beta", "Beta"));
    assert_eq!(head.unlink("cut-a", false), None);
}

#[test]
fn head_unlink_shrinks_the_list_and_keeps_promoted() {
    let mut head = DiscussionHead::parse(&promoted_doc("alpha", "Alpha", "cut-a, cut-b", "x"));
    assert_eq!(head.unlink("cut-a", true), Some(Status::Promoted));
    assert_eq!(head.promoted_to, vec!["cut-b"]);
    assert!(head.write_back().unwrap().unwrap().contains("status: promoted\npromoted_to: cut-b\n"));
}

#[test]
fn head_unlink_drops_the_line_and_reverts_by_conclusion_when_the_list_empties() {
    let mut head = DiscussionHead::parse(&promoted_doc("alpha", "Alpha", "cut-a", "x"));
    assert_eq!(head.unlink("cut-a", true), Some(Status::Concluded));
    let text = head.write_back().unwrap().unwrap();
    assert!(!text.contains("promoted_to:"), "promoted_to 行移除: {text}");
    assert!(text.contains("status: concluded\n"));

    let mut head = DiscussionHead::parse(&promoted_unconcluded_doc("alpha", "cut-a"));
    assert_eq!(head.unlink("cut-a", false), Some(Status::Open));
    let text = head.write_back().unwrap().unwrap();
    assert!(!text.contains("promoted_to:"));
    assert!(text.contains("status: open\n"));
}

#[test]
fn head_conclude_flips_open_and_unknown_keeps_promoted_and_sets_or_clears_hold() {
    let mut head = DiscussionHead::parse("---\nstatus: open\n---\n");
    head.conclude(true);
    assert_eq!(head.status, Status::Concluded);
    assert!(head.hold);
    assert_eq!(head.write_back().unwrap().as_deref(), Some("---\nstatus: concluded\nhold: true\n---\n"));

    let mut head = DiscussionHead::parse("---\nstatus: parked\n---\n");
    head.conclude(false);
    assert_eq!(head.status, Status::Concluded);

    let mut head = DiscussionHead::parse(&held_promoted_doc("alpha", "cut-a"));
    head.conclude(false);
    assert_eq!(head.status, Status::Promoted, "Promoted 保持");
    assert!(!head.hold);
    assert!(!head.write_back().unwrap().unwrap().contains("hold:"));

    let mut head = DiscussionHead::parse("---\nstatus: concluded\n---\n");
    head.conclude(false);
    assert_eq!(head.status, Status::Concluded);
}

// --- DiscussionInfo 的 serde(skip) 投影（lifecycle-discussion-head design D5）---

fn doc_of(slug: &str, text: &str) -> crate::store::DiscussionDoc {
    crate::store::DiscussionDoc {
        slug: slug.to_string(),
        text: text.to_string(),
        path: std::path::PathBuf::from(format!("openspec/discussions/{slug}.md")),
        archived: false,
    }
}

#[test]
fn info_from_doc_projects_concluded_and_the_head_from_the_record() {
    let text = "---\ntopic: Alpha\nslug: alpha\nstatus: promoted\npromoted_to: cut-a, cut-b\n\
                    created: 2026-01-02\nhold: true\nboard_rank: n\n---\n\n## Conclusion\n\n**Decision**: x\n";
    let info = super::info_from_doc(&doc_of("alpha", text));
    assert_eq!(info.head.promoted_to, vec!["cut-a", "cut-b"]);
    assert!(info.concluded);
    assert!(info.head.hold);
    assert_eq!(info.head.board_rank.as_deref(), Some("n"));

    let info = super::info_from_doc(&doc_of("beta", &open_doc("beta", "Beta")));
    assert!(info.head.promoted_to.is_empty());
    assert!(!info.concluded, "占位注解不算结论");
    assert!(!info.head.hold);
    assert_eq!(info.head.board_rank, None);
}

#[test]
fn info_serialization_omits_concluded_and_the_head() {
    let text = "---\ntopic: Alpha\nslug: alpha\nstatus: promoted\npromoted_to: cut-a\n\
                    created: 2026-01-02\nhold: true\nboard_rank: n\n---\n\n## Conclusion\n\n**Decision**: x\n";
    let json = serde_json::to_string(&super::info_from_doc(&doc_of("alpha", text))).unwrap();
    for key in ["promotedTo", "promoted_to", "concluded", "held", "hold", "head", "boardRank", "board_rank"] {
        assert!(!json.contains(&format!("\"{key}\"")), "`{key}` 不得进 JSON: {json}");
    }
    assert!(json.contains("\"status\":\"promoted\""));
}

#[test]
fn info_deserializes_without_the_skip_keys_to_defaults() {
    let json = r#"{"slug":"alpha","topic":"Alpha","status":"open","rounds":0,"created":"2026-01-02","path":"openspec/discussions/alpha.md","archived":false}"#;
    let info: super::DiscussionInfo = serde_json::from_str(json).unwrap();
    assert!(info.head.promoted_to.is_empty());
    assert!(!info.concluded);
    assert!(!info.head.hold);
    assert_eq!(info.head.board_rank, None);
    // 带着四键的 JSON 也照样解码成缺省（skip 端不读）。
    let json = r#"{"slug":"alpha","topic":"Alpha","status":"open","rounds":0,"created":"2026-01-02","path":"p","archived":false,"promotedTo":["x"],"concluded":true,"held":true,"boardRank":"n"}"#;
    let info: super::DiscussionInfo = serde_json::from_str(json).unwrap();
    assert!(info.head.promoted_to.is_empty());
    assert!(!info.concluded);
}

// --- write_back 只写有改动的字段、插入失败回 Err（review Round 1）---

#[test]
fn head_write_back_touches_only_the_fields_that_changed() {
    // 没有 status 行、手改 hold: false、promoted_to 带怪空白：只设 board_rank 时
    // 其余三栏一个比特都不动——不补 status: open、不删 hold: false、不重排清单。
    let text = "---\ntopic: x\nslug: x\npromoted_to: cut-a ,cut-b\nhold: false\n---\nbody\n";
    let mut head = DiscussionHead::parse(text);
    head.board_rank = Some("n".into());
    assert_eq!(
        head.write_back().unwrap().as_deref(),
        Some("---\ntopic: x\nslug: x\npromoted_to: cut-a ,cut-b\nhold: false\nboard_rank: n\n---\nbody\n")
    );
}

#[test]
fn head_conclude_restates_the_hold_line_but_promote_leaves_it_verbatim() {
    // conclude(false) 的 hold 是明确重述：`hold: yes`（读成 false）也整行移除。
    // promote 不碰 hold：同一行原封不动留在原位。
    let mut head = DiscussionHead::parse("---\nstatus: open\nhold: yes\n---\n");
    head.conclude(false);
    assert_eq!(head.write_back().unwrap().as_deref(), Some("---\nstatus: concluded\n---\n"));
    let mut head = DiscussionHead::parse("---\nstatus: open\nhold: yes\n---\n");
    assert!(head.promote("cut", false));
    assert_eq!(
        head.write_back().unwrap().as_deref(),
        Some("---\nstatus: promoted\nhold: yes\npromoted_to: cut\n---\n")
    );
}

#[test]
fn head_write_back_errors_when_an_unclosed_frontmatter_cannot_take_a_new_line() {
    // 未闭合 frontmatter 缺 promoted_to：promote 要新插一行、无处可插 → Err，
    // 而不是与「没有 frontmatter」同一个 None。原位代换（status）不受影响。
    let mut head = DiscussionHead::parse("---\nstatus: open\n");
    assert!(head.promote("cut", false));
    assert!(head.write_back().is_err());
    let mut head = DiscussionHead::parse("---\nstatus: open\n");
    head.conclude(false);
    assert_eq!(head.write_back().unwrap().as_deref(), Some("---\nstatus: concluded\n"));
    assert_eq!(DiscussionHead::parse("no frontmatter\n").write_back().unwrap(), None);
}

#[test]
fn mark_promoted_on_an_unclosed_record_without_promoted_to_errors_and_keeps_the_text() {
    let unclosed = "---\ntopic: x\nslug: x\nstatus: open\n";
    let store = TestStore::with_live_discussion("x", unclosed);
    assert!(super::mark_promoted(&store, "x", "cut", false).is_err(), "无处可插要大声失败");
    assert_eq!(store.discussion("x"), unclosed);
}

// --- record_cuts（discussion-cuts-from-engine design「一份记录的刀以单一入口计算」）---

use super::cuts::RecordCut;

/// Decision 为 client-protocol「分刀各栏」Example 三列的已结论记录。
fn cuts_doc() -> String {
    concluded_doc(
        "panel",
        "Panel",
        "定案。\n\n- **cut 1 `a`**: 骨架——三种详情页改三栏\n\
         - **cut 2 外壳**（拆两个 change：`b` 外壳、`c` 菜单）\n\
         - **cut 3 `d` `e`**: 收尾\n",
    )
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn record_cut(cut: &str, title: &str, note: &str, line: &str, changes: &[&str], in_bold: bool, unpromoted: &[&str]) -> RecordCut {
    RecordCut {
        cut: cut.into(),
        title: title.into(),
        note: note.into(),
        line: line.into(),
        changes: names(changes),
        changes_in_bold: in_bold,
        unpromoted: names(unpromoted),
    }
}

#[test]
fn record_cuts_carries_the_example_columns() {
    let cuts = super::record_cuts(&cuts_doc(), &names(&["a"]));
    assert_eq!(
        cuts,
        [
            record_cut("cut 1", "骨架", "三种详情页改三栏", "**cut 1 `a`**: 骨架——三种详情页改三栏", &["a"], true, &[]),
            record_cut(
                "cut 2",
                "外壳",
                "拆两个 change：`b` 外壳、`c` 菜单",
                "**cut 2 外壳**（拆两个 change：`b` 外壳、`c` 菜单）",
                &["b", "c"],
                false,
                &[],
            ),
            record_cut("cut 3", "收尾", "", "**cut 3 `d` `e`**: 收尾", &["d", "e"], true, &["d", "e"]),
        ]
    );
}

#[test]
fn record_cuts_unpromoted_follows_promoted_to_and_stays_empty_without_names_in_bold() {
    let none = super::record_cuts(&cuts_doc(), &[]);
    let unpromoted: Vec<_> = none.iter().map(|c| c.unpromoted.clone()).collect();
    // promoted_to 为空：粗体内有变更名的刀全部尚未转出；变更名不在粗体内的 cut 2 无从判定、为空。
    assert_eq!(unpromoted, [names(&["a"]), names(&[]), names(&["d", "e"])]);
    let all = super::record_cuts(&cuts_doc(), &names(&["a", "b", "c", "d", "e"]));
    assert!(all.iter().all(|c| c.unpromoted.is_empty()));
}

#[test]
fn record_cuts_is_empty_without_a_conclusion() {
    assert_eq!(super::record_cuts(&open_doc("fresh-topic", "Fresh"), &names(&["a"])), []);
}

#[test]
fn record_cuts_line_has_the_html_comment_removed() {
    let text = concluded_doc("panel", "Panel", "定案。\n\n- **cut 1 `a`**: 骨架 <!-- 备注 -->\n");
    let cuts = super::record_cuts(&text, &[]);
    assert_eq!(cuts[0].line, "**cut 1 `a`**: 骨架");
    assert_eq!(cuts[0].title, "骨架");
}

#[test]
fn record_cuts_serialize_as_seven_camel_case_keys() {
    let cut = super::record_cuts(&cuts_doc(), &[]).remove(0);
    let value = serde_json::to_value(&cut).unwrap();
    let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["changes", "changesInBold", "cut", "line", "note", "title", "unpromoted"]);
}

#[test]
fn show_returns_the_text_and_info_of_one_read() {
    // server 以 discuss show 的 content 与 info 的 promoted_to 计算详情回应的 cuts：
    // 两者 SHALL 取自同一次读取（design「一份记录的刀以单一入口计算」）。
    let doc = cuts_doc().replacen("status: concluded\n", "status: concluded\npromoted_to: a\n", 1);
    let store = TestStore::with_live_discussion("panel", &doc);
    let (info, text) = super::show(&store, "panel").expect("found");
    assert_eq!(text, doc);
    assert_eq!(info.head.promoted_to, ["a"]);
    assert_eq!(
        serde_json::to_value(&info).unwrap(),
        serde_json::to_value(super::info(&store, "panel").unwrap()).unwrap(),
        "info 与 discuss::info 同值"
    );
    assert!(super::show(&store, "no-such-topic").is_none());
}
