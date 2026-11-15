//! CredentialStore 与 connection registry 的契约测试（design 决策 2「credential
//! 唯一落点 OS Keychain，Rust 侧进出」、决策 4「connection registry 文件形状与
//! 位置」；规格「connection registry 不含 secret 且跨重启保留」）。
//!
//! CI 无 headless Keychain 可用——trait 注入是唯一可测形状：此处测 in-memory
//! 实作的逐 origin＋种类语意；keyring 生产实作走同一 trait，于手动验收
//! （security find-generic-password）确认。registry 档的串行化字段全集在此
//! 钉死：无任何 token 字段是规格铁律。

use specseal_desktop_lib::connections::{
    add_connection, read_registry, remove_connection, upsert_connection, write_registry,
    ConnectionEntry,
};
use specseal_remote::credentials::{CredentialKind, CredentialStore, MemoryCredentialStore};

// --- CredentialStore：逐 origin＋种类（refresh/pat）语意 ---

#[test]
fn credentials_are_keyed_by_origin_and_kind() {
    let store = MemoryCredentialStore::new();
    store
        .set("http://a.example:8080", CredentialKind::Refresh, "spk_rt_a")
        .expect("set");

    // 同 origin 不同种类、不同 origin 同种类，互不可见。
    assert_eq!(
        store
            .get("http://a.example:8080", CredentialKind::Refresh)
            .expect("get")
            .as_deref(),
        Some("spk_rt_a")
    );
    assert_eq!(
        store
            .get("http://a.example:8080", CredentialKind::Pat)
            .expect("get"),
        None
    );
    assert_eq!(
        store
            .get("http://b.example:8080", CredentialKind::Refresh)
            .expect("get"),
        None
    );
}

#[test]
fn set_overwrites_the_previous_secret_for_the_same_slot() {
    let store = MemoryCredentialStore::new();
    store
        .set("http://a.example", CredentialKind::Refresh, "spk_rt_old")
        .expect("set");
    store
        .set("http://a.example", CredentialKind::Refresh, "spk_rt_new")
        .expect("overwrite");
    assert_eq!(
        store
            .get("http://a.example", CredentialKind::Refresh)
            .expect("get")
            .as_deref(),
        Some("spk_rt_new"),
        "rotation 回写后最新 refresh credential 生效"
    );
}

#[test]
fn delete_removes_the_slot_and_is_idempotent() {
    let store = MemoryCredentialStore::new();
    store
        .set("http://a.example", CredentialKind::Pat, "spk_pat_x")
        .expect("set");
    store
        .delete("http://a.example", CredentialKind::Pat)
        .expect("delete");
    assert_eq!(
        store
            .get("http://a.example", CredentialKind::Pat)
            .expect("get"),
        None
    );
    // 注销时 Keychain 已空不该是错误——删除不存在的 entry 幂等成功。
    store
        .delete("http://a.example", CredentialKind::Pat)
        .expect("double delete is idempotent");
}

// --- registry：串行化字段全集，无任何 token 字段 ---

#[test]
fn registry_round_trips_and_serializes_exactly_the_secret_free_field_set() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("connections.json");

    let entries = vec![
        ConnectionEntry {
            id: "conn_a".to_string(),
            origin: "http://a.example:8080".to_string(),
            name: "工作站 A".to_string(),
            last_actor_display: Some("Dev <dev@example.com>".to_string()),
        },
        ConnectionEntry {
            id: "conn_b".to_string(),
            origin: "http://b.example:8080".to_string(),
            name: "工作站 B".to_string(),
            last_actor_display: None,
        },
    ];
    write_registry(&path, &entries).expect("write");
    let back = read_registry(&path);
    assert_eq!(back, entries, "registry 跨重启保留（往返不变）");

    // 字段全集钉死：id、origin、name、lastActorDisplay——没有其他字段，
    // 特别是没有任何 token/credential 字段。
    let json: serde_json::Value = serde_json::to_value(&entries[0]).expect("serialize an entry");
    let keys: Vec<&str> = json
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["id", "lastActorDisplay", "name", "origin"],
        "字段全集（依序排序后）：{json}"
    );

    // 身分未知时该字段整个省略，而不是落 null。
    let bare: serde_json::Value = serde_json::to_value(&entries[1]).expect("serialize");
    let bare_keys: Vec<&str> = bare
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(bare_keys, ["id", "name", "origin"]);

    // 文件内容整体扫一遍：不含任何 secret 样式字面。
    let raw = std::fs::read_to_string(&path).expect("read raw");
    for needle in ["token", "secret", "spk_rt_", "spk_at_", "spk_pat_"] {
        assert!(!raw.contains(needle), "registry 档不含 {needle}：{raw}");
    }
}

#[test]
fn upserting_the_same_origin_updates_the_display_name_in_place() {
    let mut entries = Vec::new();
    let first = upsert_connection(&mut entries, "http://localhost:8080/", "本地").expect("add");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].origin, "http://localhost:8080",
        "baseUrl 范式为 origin（去尾斜线/路径）"
    );
    assert!(!entries[0].id.is_empty(), "条目有识别 id");

    // 同 origin（即使写法不同）重复添加＝更新显示名，不长第二条，id 稳定。
    let second = upsert_connection(&mut entries, "HTTP://localhost:8080/some/path?q=1", "改名")
        .expect("upsert");
    assert_eq!(entries.len(), 1, "一 origin 一条目");
    assert_eq!(entries[0].name, "改名");
    assert_eq!(first, second, "更新显示名不换 id");

    // 不同 origin 才添加第二条。
    upsert_connection(&mut entries, "http://other.example:9000", "另一台").expect("add other");
    assert_eq!(entries.len(), 2);
}

#[test]
fn an_invalid_base_url_is_refused() {
    let mut entries = Vec::new();
    upsert_connection(&mut entries, "not-a-url", "坏").expect_err("无 scheme 的输入被拒");
    assert!(entries.is_empty());
}

#[test]
fn concurrent_adds_serialize_and_lose_no_entries() {
    // async 化后 connection_add 不再由主线程天然串行化：无锁的
    // read→upsert→write 并行时会互相盖写。add_connection 的行程内锁必须
    // 让每一笔都留下来。
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("connections.json");
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let path = path.clone();
            std::thread::spawn(move || {
                add_connection(&path, &format!("http://host{i}.example:8080"), &format!("c{i}"))
                    .expect("add")
            })
        })
        .collect();
    for h in handles {
        h.join().expect("add thread");
    }
    assert_eq!(
        read_registry(&path).len(),
        8,
        "并行 add 一笔都不得丢失"
    );
}

#[test]
fn remove_connection_deletes_the_entry_and_is_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("connections.json");
    let entry = add_connection(&path, "http://gone.example:8080", "要移除").expect("add");
    let credentials = MemoryCredentialStore::new();

    let removed = remove_connection(&path, &entry.id, &credentials).expect("remove");
    assert_eq!(removed.as_deref(), Some("http://gone.example:8080"));
    assert!(read_registry(&path).is_empty(), "条目已删");

    // 幂等：不存在的 id 是 no-op。
    let missing = remove_connection(&path, &entry.id, &credentials).expect("idempotent");
    assert_eq!(missing, None);
}

#[test]
fn a_corrupt_registry_file_reads_as_an_empty_list() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("connections.json");
    std::fs::write(&path, "{{{ not json").expect("write corrupt bytes");
    assert!(read_registry(&path).is_empty(), "坏 JSON 归零清单、不崩溃");
    // 文件不存在同样是空清单。
    assert!(read_registry(&dir.path().join("missing.json")).is_empty());
}
