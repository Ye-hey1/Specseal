//! Structural validation of changes and specs.

use crate::model::{self, Change};
use crate::schema::Schema;
use crate::store::Store;
use crate::tasks;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ValidationResult {
    pub change: String,
    pub errors: Vec<String>,
    pub valid: bool,
    pub warnings: Vec<String>,
}

/// validate 的目标集（design D4）：两个独立的开关，由旗标组合解出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidateTargets {
    pub changes: bool,
    pub specs: bool,
}

/// 旗标组合 → 目标集的单一定义：`--specs` 单独＝只验规格；`--all`＝两边都验；
/// `--specs --changes` 同传＝联集（与 `--all` 等效）；两旗标皆缺席＝只验 changes
/// （现行行为不变）。`--specs` 与 item 同传是参数错误：--specs 验的是全部正典
/// 规格、无法指定单一份，联集语意只会让人以为指定生效了——大声拒绝。fs 与
/// remote 两条路径读同一支，旗标语意与错误措辞不会各自漂移。
pub fn validate_targets(
    item: Option<&str>,
    all: bool,
    changes: bool,
    specs: bool,
) -> Result<ValidateTargets, String> {
    if item.is_some() && specs {
        return Err(
            "--specs validates the canonical specs and cannot be combined with a name; \
run `specseal validate --specs` alone, or `specseal validate --all` for both sides"
                .to_string(),
        );
    }
    Ok(ValidateTargets {
        changes: !specs || changes || all || item.is_some(),
        specs: specs || all,
    })
}

/// 一份正式规格的验证（design D4）：缺 `## Purpose` 区段或内容为空＝error；
/// 内容不足门槛＝warning（仅 strict 报）；内容仍为 archive 占位＝warning（不依附
/// strict——占位句恒长于门槛，长度判准抓不到它）。fs 与 remote 两模式共用这一支：
/// 前者从 Store 读正式规格，后者由 client 取回内容后本地运行，输出因此同形。
pub fn validate_canonical_spec(cap: &str, text: &str, strict: bool) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    // 消息里的路径是逻辑路径（openspec 相对），一律正斜线。
    let at = format!("specs/{cap}/spec.md");
    match model::purpose_content(text) {
        None => errors.push(format!("{at}: {}", model::PurposeDefect::Missing.reason())),
        Some(content) => {
            let len = content.chars().count();
            if content.starts_with(model::PURPOSE_TBD_PREFIX) {
                warnings.push(format!(
                    "{at}: Purpose is still the placeholder written by archive — \
replace it with what this capability actually covers"
                ));
            } else if strict && len < model::MIN_PURPOSE_LENGTH {
                warnings.push(format!("{at}: {}", model::PurposeDefect::TooShort(len).reason()));
            }
        }
    }
    ValidationResult {
        change: cap.to_string(),
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

/// 全部正式规格的验证结果，依 capability id 排序（沿 listing 的既有惯例——
/// Store 的枚举顺序是文件系统顺序，不可依赖）。
pub fn validate_specs(store: &dyn Store, strict: bool) -> Vec<ValidationResult> {
    let mut caps = store.list_canonical_capabilities();
    caps.sort();
    caps.iter()
        .map(|cap| {
            let text = store.read_canonical_spec(cap).unwrap_or_default();
            validate_canonical_spec(cap, &text, strict)
        })
        .collect()
}

/// 新开 capability 的 Purpose 不合格时的 error 消息（design D2）：说明规则、
/// 点名不合格原因，并附可直接照抄的范例骨架——propose 收尾跑 validate 失败即修，
/// 错误消息本身就是教材。
fn purpose_guidance(cap: &str, defect: &model::PurposeDefect) -> String {
    format!(
        "specs/{cap}/spec.md: new capability '{cap}' — {reason}. \
A capability the canonical specs do not carry yet must open its delta with a \
`## Purpose` section of one or two sentences ({min} characters or more); it becomes \
the new canonical spec's Purpose when the change is archived.\n    \
Add this above the first operation section:\n      ## Purpose\n\n      \
<what this capability covers and where its boundary lies — one or two sentences>",
        reason = defect.reason(),
        min = model::MIN_PURPOSE_LENGTH,
    )
}

fn misplaced_marker_guidance(path: &str, m: &tasks::Misplaced) -> String {
    let marker = tasks::MANUAL_MARKER;
    let cause = match m.kind {
        tasks::MisplacedMarker::AfterNumber => "the task number took the marker slot",
        tasks::MisplacedMarker::PrefixSlotMissed => {
            "the marker slot takes exactly one space after the checkbox"
        }
    };
    let mut msg = format!(
        "{path}: Task {id} (\"{desc}\"): misplaced `{marker}` marker — {cause}, so the engine \
reads `{marker}` as description text and counts the task as code work that never completes.",
        id = m.task_id,
        desc = m.description,
    );
    // The repair examples reproduce the original line faithfully — checkbox state and
    // trailing stable-ID comment included — so following them verbatim cannot uncheck a
    // done task or sever its identity. A description that is nothing but the marker has
    // no line worth rebuilding; the rule sentence above already says it all.
    let body = m.description.replacen(marker, "", 1);
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if !body.is_empty() {
        let check = if m.done { 'x' } else { ' ' };
        let tail = m
            .stable_id
            .as_deref()
            .map(|id| format!(" <!-- specseal-task:{id} -->"))
            .unwrap_or_default();
        // The wrong line is rebuilt rather than quoted — the double space of a missed
        // prefix slot would otherwise be invisible in the example.
        let wrong = match m.kind {
            tasks::MisplacedMarker::AfterNumber => m.description.clone(),
            tasks::MisplacedMarker::PrefixSlotMissed => format!(" {}", m.description),
        };
        msg.push_str(&format!(
            "\n    Write:  - [{check}] {marker} {body}{tail}\n    Not:    - [{check}] {wrong}{tail}"
        ));
    }
    msg
}

/// 新开 capability 撞近似既有名的 warning 文本（design D5）：近似名各附来源
/// 标注与 Purpose 首行，指引两条路——同一 capability 就改用既有名、确为新
/// capability 可忽略本警告。
fn naming_warning(cap: &str, suggestions: &[crate::capname::KnownName]) -> String {
    let mut msg = format!(
        "specs/{cap}/spec.md: new capability '{cap}' is close to existing names:\n"
    );
    for s in suggestions {
        msg.push_str(&format!("      - {}\n", crate::capname::suggestion_line(s)));
    }
    msg.push_str(
        "    If this is the same capability, rename the delta directory to the existing name; \
if it really is new, ignore this warning.",
    );
    msg
}

/// validate 用的变更 schema（project → user → 内置）。解析不到或坏档时以
/// spec-driven 代之：validate 不因 schema 问题拒绝，缺 delta 警告照旧。
pub fn change_schema(
    ws: Option<&crate::workspace::Workspace>,
    user_dir: Option<&std::path::Path>,
    change: &Change,
) -> Schema {
    match crate::schema::resolve_with(ws, user_dir, &change.meta.schema_name()) {
        Some(Ok(schema)) => schema,
        _ => crate::schema::spec_driven(),
    }
}

/// 只含结构检查的 change 验证（design D1）：archive 家族的验证前置专用。
/// 那里的前置后面紧接自己的合并守门与 `merge_refusal` 聚合文案；前置若也含守门，
/// 违规会先以「Validation failed:」的形状跳出来，等于改了冻结输出。输出与本
/// change 之前的 `validate_change` 逐比特相同。
pub(crate) fn validate_change_structural(
    store: &dyn Store,
    change: &Change,
    strict: bool,
) -> ValidationResult {
    structural_pass(store, change, true, strict).result
}

/// change 验证的入口（design D1）：结构检查的结果，加上与 archive 相同的合并
/// 守门违规。守门判断沿用 `archive::capability_violations`（`merge_violations`
/// 的逐 capability 本体；结构层读过的 delta 内文直接传入，不重读）——validate
/// 是 spec archive-merge「过期判定单源共用」的第四个共用者，不平行实作。
///
/// 每笔违规化为一条 error（design D2，组字见 `MergeViolation::validation_error`），
/// 一律排在既有结构 error 之后，`valid` 仍为 `errors.is_empty()`，且不依附 `strict`。
///
/// `schema` 是变更自己的 schema（见 [`change_schema`]）：它没有 specs artifact 时，
/// 缺 delta 是预期状态，不发「No delta specs found」。
pub fn validate_change(
    store: &dyn Store,
    change: &Change,
    schema: &Schema,
    strict: bool,
) -> ValidationResult {
    let expects_deltas = schema.has_specs();
    let StructuralPass { mut result, deltas } =
        structural_pass(store, change, expects_deltas, strict);
    for d in &deltas {
        let canonical = store.read_canonical_spec(&d.capability);
        for v in crate::archive::capability_violations(&d.capability, &d.text, canonical.as_deref())
        {
            // 去重（design D3）：Purpose 类一律略过——结构层的 Purpose error 已含
            // 范例骨架，比守门的 reason 更完整。
            if v.is_purpose_gate() {
                continue;
            }
            // 撞名类只在结构层已报过该需求名时略过；含 RENAMED 端点的撞名结构层
            // 看不到那一端，即使同名已被报过仍列出。
            if v.is_section_collision()
                && !v.involves_rename()
                && d.reported_names.contains(&v.requirement)
            {
                continue;
            }
            // 守门逐笔扫描 delta 的需求：同名在同一区段写两次、又撞正典时会产出
            // 两笔相同的违规——同字只列一行。
            let line = v.validation_error(&change.name);
            if !result.errors.contains(&line) {
                result.errors.push(line);
            }
        }
    }
    result.valid = result.errors.is_empty();
    result
}

/// 结构层对一份 delta 读到、守门追加时还会用到的事实（design D1／D3）。
struct DeltaFacts {
    capability: String,
    /// delta 内文——守门直接用，不再读一次 Store。
    text: String,
    /// 已被 Duplicate／appears in both error 点名的需求名，供撞名去重。
    reported_names: Vec<String>,
}

struct StructuralPass {
    result: ValidationResult,
    /// 依 Store 枚举顺序，与 `merge_violations` 的走访顺序相同。
    deltas: Vec<DeltaFacts>,
}

/// 结构检查本体。
fn structural_pass(
    store: &dyn Store,
    change: &Change,
    expects_deltas: bool,
    strict: bool,
) -> StructuralPass {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut deltas: Vec<DeltaFacts> = Vec::new();

    // validate is lenient: a missing proposal is NOT an error, and a scenario-less
    // requirement is NOT an error. The one hard error is an EXISTING delta spec file that parses
    // to zero applied operations (empty, RENAMED-only, or an operation-less requirement). The
    // informational "No delta specs found" warning fires only when the change's schema expects
    // deltas and there is not even a capability directory under specs/.
    let caps = store.delta_capabilities(&change.name);
    // 正典收录与否以清单逐字比对（同创建点主闸）——canonical_spec_exists 走
    // 文件系统，大小写不敏感的 fs 会把 `Auth` 当 `auth` 而让两张网同时静默。
    let canon = store.list_canonical_capabilities();
    // 近似名建议池与 cap 无关，整个 change 建一次；只有存在新开 capability
    // 时才需要（池会读全部正式规格取 Purpose 首行，白读太贵）。
    let pool = if caps.iter().any(|cap| !canon.contains(cap)) {
        crate::capname::suggestion_pool(store)
    } else {
        Vec::new()
    };
    for cap in &caps {
        let spec_path = change.dir.join("specs").join(cap).join("spec.md");
        let text = store
            .read_artifact(&change.name, &model::delta_spec_artifact(cap))
            .unwrap_or_default();
        if !model::has_delta_operation(&text) {
            // 消息里的路径是逻辑路径（openspec 相对），冻结的正典形式是正斜线；
            // Windows 的 PathBuf::join 会补反斜线，渲染时统一回正斜线。
            errors.push(format!(
                "{}: Parse error: Invalid format: Delta spec must contain at least one operation (ADDED, MODIFIED, REMOVED, or RENAMED)",
                spec_path.to_string_lossy().replace('\\', "/")
            ));
        }
        // 新开 capability（正典尚无同名规格）的 Purpose 早期检查（design D2）：
        // 不合格即 error，消息自带修复指引。既有 capability 的 delta Purpose 属
        // 忽略语意，这里零报——向后兼容。既有错误先列，这条后补，冻结项的顺序不动。
        if !canon.contains(cap) {
            if let Some(defect) = model::purpose_defect(&text) {
                errors.push(purpose_guidance(cap, &defect));
            }
            // 近似名第二网（design D5）：与创建点主闸同一建议池与排序。有建议
            // 即 warning——不改变 valid，涵盖 ingest 或手写文件绕过 CLI 的入口。
            // 池含本 change 的其他 delta（同 change 内两个近似新名也要互相看见），
            // 滤掉的只有受检 capability 自身。
            let known: Vec<crate::capname::KnownName> = pool
                .iter()
                .filter(|k| {
                    !(k.name == *cap
                        && k.source == crate::capname::Source::InFlight(change.name.clone()))
                })
                .cloned()
                .collect();
            let suggestions = crate::capname::suggest(cap, &known);
            if !suggestions.is_empty() {
                warnings.push(naming_warning(cap, &suggestions));
            }
        }
        // Duplicate requirement names are hard errors: the same
        // name twice inside one ADDED/MODIFIED/REMOVED section, or the same name across
        // two different sections. Reported with the change-relative path.
        let rel = spec_path
            .strip_prefix(&change.dir)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| spec_path.to_string_lossy().to_string())
            .replace('\\', "/");
        let mut section = "";
        let mut seen_in: Vec<(String, Vec<&str>)> = Vec::new(); // name -> sections (ordered)
        let mut reported_dup: Vec<(String, &str)> = Vec::new();
        let mut reported_cross: Vec<String> = Vec::new();
        for line in text.lines() {
            let t = line.trim_start();
            if let Some(rest) = t.strip_prefix("## ") {
                let head = rest.split_whitespace().next().unwrap_or("");
                if rest.trim_end().ends_with("Requirements")
                    && matches!(head, "ADDED" | "MODIFIED" | "REMOVED")
                {
                    section = match head {
                        "ADDED" => "ADDED",
                        "MODIFIED" => "MODIFIED",
                        _ => "REMOVED",
                    };
                } else {
                    section = "";
                }
            } else if let Some(name) = t.strip_prefix("### Requirement:") {
                if section.is_empty() {
                    continue;
                }
                let name = name.trim().to_string();
                let entry = match seen_in.iter_mut().find(|(n, _)| *n == name) {
                    Some(e) => e,
                    None => {
                        seen_in.push((name.clone(), Vec::new()));
                        seen_in.last_mut().unwrap()
                    }
                };
                if entry.1.contains(&section) {
                    if !reported_dup.iter().any(|(n, s)| *n == name && *s == section) {
                        errors.push(format!(
                            "{rel}: Duplicate requirement '{name}' in {section} section"
                        ));
                        reported_dup.push((name.clone(), section));
                    }
                } else {
                    if let Some(first) = entry.1.first() {
                        if !reported_cross.contains(&name) {
                            errors.push(format!(
                                "{rel}: Requirement '{name}' appears in both {first} and {section} sections"
                            ));
                            reported_cross.push(name.clone());
                        }
                    }
                    entry.1.push(section);
                }
            }
        }
        deltas.push(DeltaFacts {
            capability: cap.clone(),
            reported_names: reported_dup
                .iter()
                .map(|(n, _)| n.clone())
                .chain(reported_cross.iter().cloned())
                .collect(),
            text,
        });
    }
    // 手动标记位置检查（design D3）：`[M]` 写在前缀槽外时解析不到,任务被静默算成
    // 写码任务。既有错误先列,这条后补,冻结项的顺序不动。路径与零操作 parse error
    // 同惯例:含 change 目录的逻辑路径,渲染统一正斜线。
    let tasks_md = store.read_artifact(&change.name, "tasks.md").unwrap_or_default();
    let misplaced = tasks::misplaced_markers(&tasks::parse(&tasks_md));
    if !misplaced.is_empty() {
        let path = change.dir.join("tasks.md").to_string_lossy().replace('\\', "/");
        errors.extend(misplaced.iter().map(|m| misplaced_marker_guidance(&path, m)));
    }

    let has_cap_dirs = store.has_capability_dirs(&change.name);
    if expects_deltas && caps.is_empty() && !has_cap_dirs {
        warnings.push("No delta specs found".to_string());
    }
    let _ = strict;

    let valid = errors.is_empty();
    StructuralPass {
        result: ValidationResult {
            change: change.name.clone(),
            errors,
            valid,
            warnings,
        },
        deltas,
    }
}

#[cfg(test)]
mod tests;
