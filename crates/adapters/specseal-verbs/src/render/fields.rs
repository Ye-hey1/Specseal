//! Output of the free-field verbs (host-free-fields D4).

use serde_json::{json, Value};
use specseal_core::command::FieldsOutcome;

use super::{JsonForm, Paint, RenderOptions, Rendered, Text};
pub use crate::families::fields::FieldKind;

/// `--json`: the subject under `change` or `discussion`, and every field
/// after the write.
pub fn edited_json(kind: FieldKind, o: &FieldsOutcome) -> Value {
    let key = match kind {
        FieldKind::Change => "change",
        FieldKind::Discussion => "discussion",
    };
    json!({ key: o.subject, "fields": o.fields })
}

/// One line with the keys the call changed, in byte order, and no value: a
/// changed key that is still a field was set, one that is gone was unset.
pub fn edited_human(o: &FieldsOutcome, paint: &Paint) -> Text {
    let (set, unset): (Vec<&str>, Vec<&str>) =
        o.changed.iter().map(String::as_str).partition(|key| o.fields.contains_key(*key));
    let what = match (set.is_empty(), unset.is_empty()) {
        (true, true) => "no change".to_string(),
        (false, true) => format!("set {}", set.join(", ")),
        (true, false) => format!("unset {}", unset.join(", ")),
        (false, false) => format!("set {}; unset {}", set.join(", "), unset.join(", ")),
    };
    let mut t = Text::default();
    outln!(t, "{} {}: {what}", paint.green("✓"), o.subject);
    t
}

pub fn edited(kind: FieldKind, o: &FieldsOutcome, options: RenderOptions) -> Rendered {
    Rendered::of(options, Some(JsonForm::pretty(&edited_json(kind, o))), |paint| edited_human(o, paint))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use specseal_core::command::FieldsOutcome;

    const PLAIN: Paint = Paint::new(false);
    const COLOR: Paint = Paint::new(true);
    const JSON: RenderOptions = RenderOptions { json: true, color: false };

    fn outcome(subject: &str, fields: &[(&str, &str)], changed: &[&str]) -> FieldsOutcome {
        FieldsOutcome {
            subject: subject.to_string(),
            fields: fields.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            changed: changed.iter().map(|k| k.to_string()).collect(),
        }
    }

    #[test]
    fn the_line_names_the_changed_keys_in_byte_order() {
        // 规格「设置两个字段」：change field set demo ticket=PROJ-1 source=portal。
        let set = outcome("demo", &[("source", "portal"), ("ticket", "PROJ-1")], &["source", "ticket"]);
        assert_eq!(edited_human(&set, &PLAIN).stdout, "✓ demo: set source, ticket\n");
        // 规格「移除字段」：unset demo ticket ghost，实际变动的只有 ticket。
        let unset = outcome("demo", &[("source", "portal")], &["ticket"]);
        assert_eq!(edited_human(&unset, &PLAIN).stdout, "✓ demo: unset ticket\n");
        // 规格「没有变动」。
        let none = outcome("demo", &[("source", "portal")], &[]);
        assert_eq!(edited_human(&none, &PLAIN).stdout, "✓ demo: no change\n");
        assert_eq!(edited_human(&set, &COLOR).stdout, "\x1b[32m✓\x1b[0m demo: set source, ticket\n");
    }

    #[test]
    fn an_edit_that_set_and_unset_names_both() {
        // 动词一次只做一种；在线的请求可以两种都做。
        let both = outcome("demo", &[("a", "1"), ("c", "3")], &["a", "b", "c"]);
        assert_eq!(edited_human(&both, &PLAIN).stdout, "✓ demo: set a, c; unset b\n");
    }

    #[test]
    fn the_line_never_prints_a_value() {
        let set = outcome("demo", &[("token", "s3cret")], &["token"]);
        assert!(!edited_human(&set, &PLAIN).stdout.contains("s3cret"));
    }

    #[test]
    fn json_is_the_subject_and_every_field_after_the_write() {
        // 规格「--json 回传全部字段」。
        let o = outcome("demo", &[("source", "portal"), ("ticket", "PROJ-1")], &["ticket"]);
        let change = edited_json(FieldKind::Change, &o);
        assert_eq!(change, json!({ "change": "demo", "fields": { "source": "portal", "ticket": "PROJ-1" } }));
        assert!(change["change"].is_string() && change["fields"].is_object());
        assert!(change["fields"].as_object().unwrap().values().all(serde_json::Value::is_string));
        // 规格「讨论的字段」。
        let o = outcome("board-search", &[("owner", "alice")], &["owner"]);
        let discussion = edited_json(FieldKind::Discussion, &o);
        assert_eq!(discussion, json!({ "discussion": "board-search", "fields": { "owner": "alice" } }));
        // 没有字段时 fields 是空对象，不是省略。
        let empty = edited_json(FieldKind::Change, &outcome("demo", &[], &["ticket"]));
        assert_eq!(empty, json!({ "change": "demo", "fields": {} }));
        // 没有变动时 JSON 一样是全部字段。
        let rendered = edited(FieldKind::Change, &outcome("demo", &[("a", "1")], &[]), JSON);
        assert_eq!(rendered.json, Some(json!({ "change": "demo", "fields": { "a": "1" } })));
        assert!(rendered.stdout.contains("\"change\": \"demo\""));
    }
}
