//! Workflow schemas: the embedded built-ins (`spec-driven`, `no-spec-change`) plus custom
//! schemas in the OpenSpec format (`openspec/schemas/<name>/schema.yaml` + `templates/`).
//! Resolution order: project → user → built-in.

use crate::workspace::Workspace;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// A single artifact definition within a schema.
#[derive(Debug, Clone)]
pub struct Artifact {
    pub id: String,
    /// Output path pattern relative to the change directory (`generates`).
    pub output_path: String,
    /// Template file name (shown by `templates`).
    pub template_name: String,
    pub description: String,
    /// Artifact ids that must be done before this one is ready.
    pub requires: Vec<String>,
    /// Guidance text; custom schemas may omit it.
    pub instruction: Option<String>,
    /// Template content; None when the template file is missing.
    pub template: Option<String>,
}

/// A workflow schema.
#[derive(Debug, Clone)]
pub struct Schema {
    /// Resolution key — for custom schemas this is the directory name.
    pub name: String,
    /// The yaml `name:` field — what payloads and `status` display as the schema name
    /// (a pristine fork still reports "spec-driven").
    pub display_name: String,
    /// Display description. Custom schemas show none (frozen output shape).
    pub description: Option<String>,
    /// "package" | "project" | "user"
    pub source: String,
    pub artifacts: Vec<Artifact>,
    /// Artifact ids required before `apply`.
    pub apply_requires: Vec<String>,
    pub apply_tracks: Option<String>,
    pub apply_instruction: Option<String>,
}

impl Schema {
    pub fn artifact(&self, id: &str) -> Option<&Artifact> {
        self.artifacts.iter().find(|a| a.id == id)
    }
    /// 这个 schema 是否产出 delta spec（有 id 为 `specs` 的 artifact）。
    pub fn has_specs(&self) -> bool {
        self.artifact("specs").is_some()
    }
    pub fn artifact_ids(&self) -> Vec<String> {
        self.artifacts.iter().map(|a| a.id.clone()).collect()
    }
    pub fn is_builtin(&self) -> bool {
        self.source == "package"
    }
}

const A_PROPOSAL_TMPL: &str = include_str!("../../assets/schema/spec-driven/proposal.template.md");
const A_SPECS_TMPL: &str = include_str!("../../assets/schema/spec-driven/specs.template.md");
const A_DESIGN_TMPL: &str = include_str!("../../assets/schema/spec-driven/design.template.md");
const A_TASKS_TMPL: &str = include_str!("../../assets/schema/spec-driven/tasks.template.md");
/// The single canonical definition of the built-in `spec-driven` schema: the engine
/// parses it at load, and `schema fork spec-driven` ships it byte for byte.
pub const SPEC_DRIVEN_SCHEMA_YAML: &str =
    include_str!("../../assets/schema/spec-driven/fork.schema.yaml");
const NSC_PROPOSAL_TMPL: &str =
    include_str!("../../assets/schema/no-spec-change/proposal.template.md");
/// The single canonical definition of the built-in `no-spec-change` schema.
pub const NO_SPEC_CHANGE_SCHEMA_YAML: &str =
    include_str!("../../assets/schema/no-spec-change/fork.schema.yaml");

/// Template content for a built-in schema, keyed by the `template:` file name the
/// canonical YAML declares. This is the built-in's counterpart to a custom schema's
/// `templates/` directory — the same lookup, served from the binary.
fn spec_driven_template(file_name: &str) -> Option<&'static str> {
    match file_name {
        "proposal.md" => Some(A_PROPOSAL_TMPL),
        "spec.md" => Some(A_SPECS_TMPL),
        "design.md" => Some(A_DESIGN_TMPL),
        "tasks.md" => Some(A_TASKS_TMPL),
        _ => None,
    }
}

/// no-spec-change owns only its proposal template; design and tasks map to spec-driven's
/// embedded assets so one text never lives twice.
fn no_spec_change_template(file_name: &str) -> Option<&'static str> {
    match file_name {
        "proposal.md" => Some(NSC_PROPOSAL_TMPL),
        "design.md" | "tasks.md" => spec_driven_template(file_name),
        _ => None,
    }
}

/// One built-in schema: its name, canonical YAML, embedded template lookup and the
/// schema parsed from them.
struct Builtin {
    name: &'static str,
    yaml: &'static str,
    template: fn(&str) -> Option<&'static str>,
    parsed: OnceLock<Schema>,
}

impl Builtin {
    /// Parsed once per process through the same path a custom schema takes; the
    /// canonical documents are compiled in, so a parse or validation failure is a
    /// build-time defect, not user input.
    fn schema(&self) -> &Schema {
        self.parsed.get_or_init(|| {
            parse_schema(self.yaml, self.name, "package", &|f| (self.template)(f).map(str::to_string))
                .unwrap_or_else(|e| panic!("built-in {} schema parses and validates: {e}", self.name))
        })
    }
}

/// The built-in schemas in listing order. Every built-in lookup goes through this table,
/// so no resolution path can know a built-in the others miss.
static BUILTINS: [Builtin; 2] = [
    Builtin {
        name: "spec-driven",
        yaml: SPEC_DRIVEN_SCHEMA_YAML,
        template: spec_driven_template,
        parsed: OnceLock::new(),
    },
    Builtin {
        name: "no-spec-change",
        yaml: NO_SPEC_CHANGE_SCHEMA_YAML,
        template: no_spec_change_template,
        parsed: OnceLock::new(),
    },
];

fn builtin_entry(name: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|b| b.name == name)
}

/// Built-in schema names in listing order.
pub fn builtin_names() -> impl Iterator<Item = &'static str> {
    BUILTINS.iter().map(|b| b.name)
}

/// A built-in schema by name.
pub fn builtin(name: &str) -> Option<Schema> {
    builtin_entry(name).map(|b| b.schema().clone())
}

/// The built-in `spec-driven` schema.
pub fn spec_driven() -> Schema {
    builtin("spec-driven").expect("spec-driven is a built-in")
}

// --- YAML schema files ---

#[derive(Deserialize)]
struct SchemaYaml {
    name: String,
    /// Kept as a raw value so a non-integer reads as a schema error naming the field,
    /// not as a serde type error naming a Rust type.
    #[serde(default)]
    version: Option<serde_yaml::Value>,
    #[serde(default)]
    description: Option<String>,
    artifacts: Vec<ArtifactYaml>,
    #[serde(default)]
    apply: Option<ApplyYaml>,
}

#[derive(Deserialize)]
struct ArtifactYaml {
    id: String,
    generates: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    template: Option<String>,
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    requires: Vec<String>,
}

#[derive(Deserialize)]
struct ApplyYaml {
    #[serde(default)]
    requires: Vec<String>,
    #[serde(default)]
    tracks: Option<String>,
    #[serde(default)]
    instruction: Option<String>,
}

/// DFS over the artifact `requires` graph; returns the first cycle as `a → b → a`.
fn cycle_path(arts: &[ArtifactYaml]) -> Option<String> {
    fn visit(
        id: &str,
        arts: &[ArtifactYaml],
        path: &mut Vec<String>,
        done: &mut Vec<String>,
    ) -> Option<String> {
        if done.iter().any(|d| d == id) {
            return None;
        }
        if let Some(at) = path.iter().position(|p| p == id) {
            let mut cycle: Vec<&str> = path[at..].iter().map(String::as_str).collect();
            cycle.push(id);
            return Some(cycle.join(" → "));
        }
        path.push(id.to_string());
        if let Some(a) = arts.iter().find(|a| a.id == id) {
            for r in &a.requires {
                if let Some(cycle) = visit(r, arts, path, done) {
                    return Some(cycle);
                }
            }
        }
        path.pop();
        done.push(id.to_string());
        None
    }
    let mut done = Vec::new();
    arts.iter()
        .find_map(|a| visit(&a.id, arts, &mut Vec::new(), &mut done))
}

/// Every structural check a schema document must pass before any verb may use it.
/// Mirrors the OpenSpec zod schema: required fields first, then graph integrity.
fn validate_yaml(y: &SchemaYaml) -> Result<(), String> {
    let invalid = |detail: String| Err(format!("Invalid schema: {detail}"));

    match &y.version {
        None => return invalid("version is required".to_string()),
        Some(v) if v.as_u64().is_none_or(|n| n == 0) => {
            return invalid("version must be a positive integer".to_string())
        }
        Some(_) => {}
    }

    let mut seen: Vec<&str> = Vec::with_capacity(y.artifacts.len());
    for a in &y.artifacts {
        if seen.contains(&a.id.as_str()) {
            return invalid(format!("Duplicate artifact ID: {}", a.id));
        }
        seen.push(&a.id);
        if a.description.is_none() {
            return invalid(format!("artifact '{}': description is required", a.id));
        }
        if a.template.as_deref().unwrap_or_default().is_empty() {
            return invalid(format!("artifact '{}': template is required", a.id));
        }
    }

    for a in &y.artifacts {
        for r in &a.requires {
            if !seen.contains(&r.as_str()) {
                return invalid(format!(
                    "Invalid dependency reference in artifact '{}': '{r}' does not exist",
                    a.id
                ));
            }
        }
    }

    match cycle_path(&y.artifacts) {
        Some(path) => invalid(format!("Cyclic dependency detected: {path}")),
        None => Ok(()),
    }
}

/// Schema name format, mirroring OpenSpec's `isValidSchemaName`: lowercase kebab-case —
/// a letter, then lowercase alphanumerics, with single hyphens between segments.
pub(crate) fn is_valid_schema_name(name: &str) -> bool {
    let mut segments = name.split('-');
    segments.next().is_some_and(|first| {
        first.starts_with(|c: char| c.is_ascii_lowercase())
            && first.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    }) && segments.all(|seg| {
        !seg.is_empty() && seg.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

/// Parse and validate one schema document. `templates` supplies template content by the
/// `template:` file name an artifact declares — a directory read for custom schemas, an
/// embedded lookup for the built-in.
fn parse_schema(
    text: &str,
    name: &str,
    source: &str,
    templates: &dyn Fn(&str) -> Option<String>,
) -> Result<Schema, String> {
    let y: SchemaYaml =
        serde_yaml::from_str(text).map_err(|e| format!("Schema parse error: {e}"))?;
    validate_yaml(&y)?;
    let artifacts = y
        .artifacts
        .into_iter()
        .map(|a| {
            // `validate_yaml` already refused an absent or empty template name.
            let template_name = a.template.unwrap_or_default();
            let template = templates(&template_name);
            Artifact {
                output_path: a.generates,
                template_name,
                description: a.description.unwrap_or_default(),
                requires: a.requires,
                instruction: a.instruction,
                template,
                id: a.id,
            }
        })
        .collect();
    let apply = y.apply;
    Ok(Schema {
        name: name.to_string(),
        display_name: y.name,
        // Custom schemas display no description (frozen output shape); the built-in shows
        // the canonical document's own.
        description: if source == "package" { y.description } else { None },
        source: source.to_string(),
        artifacts,
        apply_requires: apply.as_ref().map(|a| a.requires.clone()).unwrap_or_default(),
        apply_tracks: apply.as_ref().and_then(|a| a.tracks.clone()),
        apply_instruction: apply.and_then(|a| a.instruction),
    })
}

/// Load a custom schema from its directory. `name` is the directory name (the resolution key —
/// the yaml `name:` field is ignored for resolution).
pub fn load_dir(dir: &Path, name: &str, source: &str) -> Result<Schema, String> {
    let text = std::fs::read_to_string(dir.join("schema.yaml"))
        .map_err(|e| format!("Schema parse error: {e}"))?;
    let templates_dir = dir.join("templates");
    parse_schema(&text, name, source, &|file_name| {
        crate::util::read_opt(&templates_dir.join(file_name))
    })
}

// --- resolution ---

/// Schema search directories in resolution order: project then user.
/// `user_dir` is the Host-resolved machine-level specseal directory
/// (specseal-host's `global_config_dir`) — None skips the user location.
pub fn schema_dirs(
    ws: Option<&Workspace>,
    user_dir: Option<&Path>,
) -> Vec<(PathBuf, &'static str)> {
    let mut v = Vec::new();
    if let Some(w) = ws {
        v.push((w.spec_dir().join("schemas"), "project"));
    }
    if let Some(dir) = user_dir {
        v.push((dir.join("schemas"), "user"));
    }
    v
}

/// One place a schema name resolves to. `path` is None for the built-in.
pub struct SchemaSource {
    pub path: Option<PathBuf>,
    pub source: &'static str,
}

/// Every location where `name` exists, in resolution order.
pub fn sources(ws: Option<&Workspace>, user_dir: Option<&Path>, name: &str) -> Vec<SchemaSource> {
    let mut out = Vec::new();
    for (dir, src) in schema_dirs(ws, user_dir) {
        let y = dir.join(name).join("schema.yaml");
        if y.is_file() {
            out.push(SchemaSource { path: Some(y), source: src });
        }
    }
    if builtin_names().any(|b| b == name) {
        out.push(SchemaSource { path: None, source: "built-in" });
    }
    out
}

/// Resolve a schema: None = not found; Some(Err) = found but invalid (parse error / cycle).
pub fn resolve_with(
    ws: Option<&Workspace>,
    user_dir: Option<&Path>,
    name: &str,
) -> Option<Result<Schema, String>> {
    for (dir, src) in schema_dirs(ws, user_dir) {
        let d = dir.join(name);
        if d.join("schema.yaml").is_file() {
            return Some(load_dir(&d, name, src));
        }
    }
    builtin(name).map(Ok)
}

/// Template files the schema references but cannot supply — the content lookup came back
/// empty (a missing or unreadable file for a custom schema, an absent embedded asset for
/// the built-in). This is `schema validate`'s file-existence check; load deliberately
/// tolerates a missing template FILE (design D3).
pub fn missing_templates(schema: &Schema) -> Vec<String> {
    schema
        .artifacts
        .iter()
        .filter(|a| a.template.is_none())
        .map(|a| a.template_name.clone())
        .collect()
}

/// The rejection message for a schema name that is not lowercase kebab-case.
pub(crate) fn invalid_name_msg(name: &str) -> String {
    format!("Invalid schema name '{name}': must be lowercase kebab-case (e.g. my-flow)")
}

/// The not-found message for a schema name.
pub fn not_found_msg(name: &str) -> String {
    format!("Schema not found: Schema '{name}' not found in project, user, or built-in locations")
}

/// The built-in template for an artifact id, looked up by a schema's DISPLAY name — the
/// instructions payload template is filled this way (custom display names get an empty template).
pub fn builtin_template(display_name: &str, artifact_id: &str) -> Option<String> {
    builtin(display_name)?.artifact(artifact_id).and_then(|a| a.template.clone())
}

/// A schema entry for the `schemas` listing (parse failures tolerated → empty artifacts).
pub struct ListedSchema {
    pub name: String,
    pub source: &'static str,
    pub description: Option<String>,
    pub artifact_ids: Vec<String>,
}

/// All schemas: built-in first, then project (alphabetical), then user (alphabetical).
pub fn list_all(ws: Option<&Workspace>, user_dir: Option<&Path>) -> Vec<ListedSchema> {
    let mut out: Vec<ListedSchema> = builtin_names()
        .filter_map(builtin)
        .map(|b| ListedSchema {
            artifact_ids: b.artifact_ids(),
            name: b.name,
            source: "package",
            description: b.description,
        })
        .collect();
    for (dir, src) in schema_dirs(ws, user_dir) {
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map(|it| {
                it.flatten()
                    .filter(|e| e.path().join("schema.yaml").is_file())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        for n in names {
            let ids = std::fs::read_to_string(dir.join(&n).join("schema.yaml"))
                .ok()
                .and_then(|t| serde_yaml::from_str::<SchemaYaml>(&t).ok())
                .map(|y| y.artifacts.iter().map(|a| a.id.clone()).collect())
                .unwrap_or_default();
            out.push(ListedSchema { name: n, source: src, description: None, artifact_ids: ids });
        }
    }
    out
}

// --- fork / init ---

/// Fork (copy) a schema into the project's `openspec/schemas/`. Returns the new name.
pub fn fork(
    ws: &Workspace,
    user_dir: Option<&Path>,
    source: &str,
    name: Option<&str>,
    force: bool,
) -> Result<String, String> {
    let new_name = name
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{source}-custom"));
    if !is_valid_schema_name(&new_name) {
        return Err(invalid_name_msg(&new_name));
    }
    let target = ws.spec_dir().join("schemas").join(&new_name);
    if target.join("schema.yaml").is_file() && !force {
        return Err(format!("Schema '{new_name}' already exists. Use --force to overwrite."));
    }
    let srcs = sources(Some(ws), user_dir, source);
    let Some(first) = srcs.first() else {
        return Err(not_found_msg(source));
    };
    let write = |rel: &str, body: &str| -> Result<(), String> {
        crate::util::write_file(&target.join(rel), body).map_err(|e| e.to_string())
    };
    match &first.path {
        None => {
            // Built-in: ship the canonical YAML verbatim + the template each artifact declares.
            let b = builtin_entry(source).expect("sources lists a built-in only for a registered name");
            write("schema.yaml", b.yaml)?;
            for art in &b.schema().artifacts {
                let body = art.template.as_deref().unwrap_or_default();
                write(&format!("templates/{}", art.template_name), body)?;
            }
        }
        Some(yaml_path) => {
            let src_dir = yaml_path.parent().unwrap_or(Path::new("."));
            let body = std::fs::read_to_string(yaml_path).map_err(|e| e.to_string())?;
            write("schema.yaml", &body)?;
            if let Ok(entries) = std::fs::read_dir(src_dir.join("templates")) {
                for e in entries.flatten() {
                    if e.path().is_file() {
                        let fname = e.file_name().to_string_lossy().to_string();
                        let content = std::fs::read_to_string(e.path()).map_err(|e| e.to_string())?;
                        write(&format!("templates/{fname}"), &content)?;
                    }
                }
            }
        }
    }
    Ok(new_name)
}

/// Create a new custom schema skeleton. Returns its directory.
///
/// The document is serialized as one YAML value, never string-concatenated — any scalar
/// (a description carrying `: ` or newlines) stays parseable. Artifact ids double as
/// template file names on disk, so they carry the same kebab-case rule as schema names —
/// that is also what keeps them from escaping the schema directory. The generated
/// document must pass its own load checks before anything reaches the disk: init never
/// leaves a skeleton that its own `schema validate` refuses.
pub fn init_schema(
    ws: &Workspace,
    name: &str,
    artifacts: Option<&str>,
    description: Option<&str>,
    force: bool,
) -> Result<PathBuf, String> {
    if !is_valid_schema_name(name) {
        return Err(invalid_name_msg(name));
    }
    let target = ws.spec_dir().join("schemas").join(name);
    if target.join("schema.yaml").is_file() && !force {
        return Err(format!("Schema '{name}' already exists. Use --force to overwrite."));
    }
    let ids: Vec<String> = artifacts
        .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        .filter(|v: &Vec<String>| !v.is_empty())
        .unwrap_or_else(|| vec!["plan".to_string(), "tasks".to_string()]);
    for id in &ids {
        if !is_valid_schema_name(id) {
            return Err(format!(
                "Invalid artifact id '{id}': must be lowercase kebab-case (e.g. plan)"
            ));
        }
    }
    let desc = description
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Custom schema: {name}"));

    let mut doc = serde_yaml::Mapping::new();
    doc.insert("name".into(), name.into());
    doc.insert("version".into(), 1.into());
    doc.insert("description".into(), desc.into());
    let arts: Vec<serde_yaml::Value> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let mut a = serde_yaml::Mapping::new();
            a.insert("id".into(), id.as_str().into());
            a.insert("generates".into(), format!("{id}.md").into());
            a.insert("description".into(), format!("The {id} artifact").into());
            a.insert("template".into(), format!("{id}.md").into());
            if i > 0 {
                a.insert(
                    "requires".into(),
                    serde_yaml::Value::Sequence(vec![ids[i - 1].as_str().into()]),
                );
            }
            serde_yaml::Value::Mapping(a)
        })
        .collect();
    doc.insert("artifacts".into(), serde_yaml::Value::Sequence(arts));
    let last = &ids[ids.len() - 1];
    let mut apply = serde_yaml::Mapping::new();
    apply.insert("requires".into(), serde_yaml::Value::Sequence(vec![last.as_str().into()]));
    apply.insert("tracks".into(), format!("{last}.md").into());
    doc.insert("apply".into(), serde_yaml::Value::Mapping(apply));
    let y = serde_yaml::to_string(&serde_yaml::Value::Mapping(doc)).map_err(|e| e.to_string())?;

    // Self-check first (duplicate ids land here), write only a cleared document.
    parse_schema(&y, name, "project", &|_| Some(String::new()))?;

    crate::util::write_file(&target.join("schema.yaml"), &y).map_err(|e| e.to_string())?;
    for id in &ids {
        crate::util::write_file(
            &target.join("templates").join(format!("{id}.md")),
            &format!("# {id}\n"),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::{
        builtin, builtin_names, builtin_template, is_valid_schema_name, list_all, parse_schema,
        resolve_with, sources, spec_driven, Schema, SchemaYaml, A_DESIGN_TMPL, A_PROPOSAL_TMPL,
        A_SPECS_TMPL, A_TASKS_TMPL, BUILTINS, NSC_PROPOSAL_TMPL, SPEC_DRIVEN_SCHEMA_YAML,
    };
    use crate::workspace::Workspace;

    /// 内置 schema 的每个字段都必须等于正典 YAML 的字面——手写第二份定义会在这里红灯。
    #[test]
    fn builtin_schema_matches_the_canonical_yaml() {
        for b in &BUILTINS {
            assert_matches_canonical_yaml(b.yaml, &builtin(b.name).expect("登记表内的名称可解析"));
        }
    }

    fn assert_matches_canonical_yaml(yaml: &str, s: &Schema) {
        let y: SchemaYaml = serde_yaml::from_str(yaml).expect("正典 YAML 可解析");

        assert_eq!(s.name, y.name, "内置的解析名称等于正典 name");
        assert_eq!(s.display_name, y.name, "display_name");
        assert_eq!(s.description, y.description, "description");

        let apply = y.apply.as_ref().expect("正典 YAML 带 apply 区块");
        assert_eq!(s.apply_requires, apply.requires, "apply.requires");
        assert_eq!(s.apply_tracks, apply.tracks, "apply.tracks");
        assert_eq!(s.apply_instruction, apply.instruction, "apply.instruction");

        assert_eq!(s.artifacts.len(), y.artifacts.len(), "artifact 数量");
        for (got, want) in s.artifacts.iter().zip(&y.artifacts) {
            assert_eq!(got.id, want.id, "artifact id");
            assert_eq!(got.output_path, want.generates, "{}: generates", want.id);
            assert_eq!(
                Some(&got.template_name),
                want.template.as_ref(),
                "{}: template 文件名",
                want.id
            );
            assert_eq!(
                Some(&got.description),
                want.description.as_ref(),
                "{}: description",
                want.id
            );
            assert_eq!(got.instruction, want.instruction, "{}: instruction", want.id);
            assert_eq!(got.requires, want.requires, "{}: requires", want.id);
        }
    }

    /// 正典每个 artifact 声明的 template 文件名都必须在内嵌资产表有对应内容——
    /// 日后在正典添加 artifact 而忘了补表，在这里红灯，而不是 schema validate 运行期。
    #[test]
    fn every_canonical_artifact_attaches_an_embedded_template() {
        for art in builtin_names().filter_map(builtin).flat_map(|s| s.artifacts) {
            assert!(
                art.template.as_deref().is_some_and(|t| !t.is_empty()),
                "{}: 正典声明的 template {} 必须在内嵌资产表有对应内容",
                art.id,
                art.template_name
            );
        }
    }

    /// specs 的起草指引承载现行规则——正典 YAML 是 instruction 的唯一来源，落后版本在这里红灯。
    #[test]
    fn specs_instruction_carries_the_current_drafting_rules() {
        let specs = spec_driven();
        let instruction = specs
            .artifact("specs")
            .and_then(|a| a.instruction.as_deref())
            .expect("specs artifact 带 instruction");
        for marker in [
            "Purpose section (new capabilities only)",
            "<!-- BEFORE:",
            "<!-- REMOVED-SCENARIO:",
        ] {
            assert!(
                instruction.contains(marker),
                "specs instruction 须点名 {marker}"
            );
        }
    }

    /// template 内容由内嵌资产附挂，逐字相同。
    #[test]
    fn builtin_templates_come_from_the_embedded_assets() {
        let s = spec_driven();
        for (id, asset) in [
            ("proposal", A_PROPOSAL_TMPL),
            ("specs", A_SPECS_TMPL),
            ("design", A_DESIGN_TMPL),
            ("tasks", A_TASKS_TMPL),
        ] {
            let art = s.artifact(id).unwrap_or_else(|| panic!("内置 schema 有 {id}"));
            assert_eq!(art.template.as_deref(), Some(asset), "{id}: template 内容");
        }
    }

    /// 内置正典必须通过全部加载检查——引擎自带的文档不得是唯一的例外。
    #[test]
    fn the_canonical_document_passes_every_check() {
        for b in &BUILTINS {
            parse_schema(b.yaml, b.name, "package", &|_| Some(String::new()))
                .unwrap_or_else(|e| panic!("{} 正典 YAML 通过全部加载检查：{e}", b.name));
        }
    }

    /// 加载检查的边界表：每列一个 schema 文档与预期的错误词组（None ＝ 必须通过）。
    #[test]
    fn load_rejects_invalid_schema_documents() {
        // 一份合法的最小文档，各列在其上改动一处。
        let ok = "\
name: t
version: 1
artifacts:
- id: plan
  generates: plan.md
  description: The plan
  template: plan.md
";
        let cases: [(&str, &str, Option<&str>); 11] = [
            ("合法最小文档", ok, None),
            (
                "重复 artifact id",
                "name: t\nversion: 1\nartifacts:\n- id: plan\n  generates: a.md\n  description: A\n  template: a.md\n- id: plan\n  generates: b.md\n  description: B\n  template: b.md\n",
                Some("Duplicate artifact ID: plan"),
            ),
            (
                "悬空 requires",
                "name: t\nversion: 1\nartifacts:\n- id: plan\n  generates: a.md\n  description: A\n  template: a.md\n  requires:\n  - ghost\n",
                Some("artifact 'plan'"),
            ),
            (
                "循环相依",
                "name: t\nversion: 1\nartifacts:\n- id: a\n  generates: a.md\n  description: A\n  template: a.md\n  requires:\n  - b\n- id: b\n  generates: b.md\n  description: B\n  template: b.md\n  requires:\n  - a\n",
                Some("a → b → a"),
            ),
            ("version 键缺席", &ok.replace("version: 1\n", ""), Some("version is required")),
            ("version 为 0", &ok.replace("version: 1", "version: 0"), Some("positive integer")),
            ("version 为小数", &ok.replace("version: 1", "version: 1.5"), Some("positive integer")),
            (
                "description 键缺席",
                &ok.replace("  description: The plan\n", ""),
                Some("description is required"),
            ),
            ("description 为空字符串", &ok.replace("description: The plan", "description: \"\""), None),
            (
                "template 键缺席",
                &ok.replace("  template: plan.md\n", ""),
                Some("template is required"),
            ),
            (
                "template 为空字符串",
                &ok.replace("template: plan.md", "template: \"\""),
                Some("template is required"),
            ),
        ];

        for (label, doc, want) in cases {
            let got = parse_schema(doc, "t", "project", &|_| Some(String::new()));
            match (want, &got) {
                (None, Err(e)) => panic!("{label}：预期通过，却回错误 {e}"),
                (Some(phrase), Ok(_)) => panic!("{label}：预期错误含「{phrase}」，却通过"),
                (Some(phrase), Err(e)) => assert!(
                    e.contains(phrase),
                    "{label}：错误消息须含「{phrase}」，实得 {e}"
                ),
                (None, Ok(_)) => {}
            }
        }
    }

    /// fork／init 的目的名称格式（对齐 OpenSpec 的 isValidSchemaName）。
    #[test]
    fn schema_names_must_be_lowercase_kebab_case() {
        for good in ["a", "my-flow", "spec-driven", "spec-driven-custom", "a1-b2"] {
            assert!(is_valid_schema_name(good), "{good} 应为合法名称");
        }
        for bad in ["", "My_Schema", "My-Schema", "1flow", "-flow", "flow-", "a--b", "a b", "a.b"] {
            assert!(!is_valid_schema_name(bad), "{bad} 应为非法名称");
        }
    }

    #[test]
    fn tasks_drafting_guidance_names_the_manual_marker_only() {
        // `[P]` 语意已移除——翻译保留规则点名的是唯一承载语意的 `[M]`。起草指引只有
        // 正典 YAML 一份，fork 出去的项目因此不会落差。
        assert!(
            SPEC_DRIVEN_SCHEMA_YAML.contains("`[M]` markers"),
            "fork.schema.yaml 须点名 `[M]` markers"
        );
        // 断言面只钉翻译保留规则那一句的旧 token——全文否定「[P]」会把
        // 日后任何合法提及(如迁移说明)一并打死。
        assert!(
            !SPEC_DRIVEN_SCHEMA_YAML.contains("`[P]` markers"),
            "fork.schema.yaml 不得再点名 `[P]` markers"
        );
    }

    const NO_SPEC_CHANGE_DESCRIPTION: &str = "No-spec-change workflow - proposal → tasks (design optional), for changes that alter no promised behavior";

    fn no_spec_change() -> Schema {
        resolve_with(None, None, "no-spec-change")
            .expect("no-spec-change 是内置")
            .expect("no-spec-change 正典 YAML 通过加载检查")
    }

    /// 第二个内置 no-spec-change：proposal → design（选用）→ tasks，没有 specs。
    #[test]
    fn no_spec_change_resolves_as_a_builtin_without_specs() {
        let s = no_spec_change();
        assert_eq!(s.source, "package");
        assert_eq!(s.display_name, "no-spec-change");
        assert_eq!(s.description.as_deref(), Some(NO_SPEC_CHANGE_DESCRIPTION));
        assert_eq!(s.artifact_ids(), ["proposal", "design", "tasks"]);
        let requires = |id: &str| s.artifact(id).map(|a| a.requires.clone()).unwrap_or_default();
        assert!(requires("proposal").is_empty(), "proposal 无前置");
        assert_eq!(requires("design"), ["proposal"]);
        assert_eq!(requires("tasks"), ["proposal"]);
        assert_eq!(s.apply_requires, ["tasks"]);
    }

    /// design 与 tasks 的 template 与 spec-driven 逐字相同；proposal 的 template 没有 Capabilities。
    #[test]
    fn no_spec_change_templates_reuse_spec_driven_design_and_tasks() {
        let s = no_spec_change();
        for art in &s.artifacts {
            assert!(
                art.template.as_deref().is_some_and(|t| !t.is_empty()),
                "{}: template 必须非空",
                art.id
            );
        }
        let template = |id: &str| s.artifact(id).and_then(|a| a.template.clone());
        assert_eq!(template("design").as_deref(), Some(A_DESIGN_TMPL));
        assert_eq!(template("tasks").as_deref(), Some(A_TASKS_TMPL));
        let proposal = template("proposal").expect("proposal 带 template");
        assert_eq!(proposal, NSC_PROPOSAL_TMPL, "proposal template 与内嵌资产逐字相同");
        assert!(!proposal.contains("## Capabilities"), "proposal template 不得含 Capabilities");
        for section in ["## Why", "## What Changes", "## Non-Goals", "## Impact"] {
            assert!(proposal.contains(section), "proposal template 须含 {section}");
        }
        // fork 出去的 no-spec-change（display name 不变）取 payload template 时拿到同一份。
        assert_eq!(builtin_template("no-spec-change", "proposal"), Some(proposal));
    }

    /// proposal 要求写明不改行为的理由与查过的规格；tasks 要求最后一项以既有测试确认行为未变、
    /// 不要求引用 requirement 名称；design 的 instruction 与 spec-driven 逐字相同。
    #[test]
    fn no_spec_change_instructions_ask_for_the_unchanged_behavior_evidence() {
        let s = no_spec_change();
        let instruction = |id: &str| {
            s.artifact(id).and_then(|a| a.instruction.clone()).unwrap_or_default()
        };
        let proposal = instruction("proposal");
        assert!(proposal.contains("alters no behavior the canonical specs promise"));
        assert!(proposal.contains("list the canonical specs you checked"));
        let tasks = instruction("tasks");
        assert!(tasks.contains("The last task MUST confirm with the existing tests"));
        assert!(!tasks.contains("`### Requirement:` name"), "tasks 不得要求引用 requirement 名称");
        let spec_driven_design = spec_driven().artifact("design").and_then(|a| a.instruction.clone());
        assert_eq!(Some(instruction("design")), spec_driven_design);
    }

    /// 列表：内置依序 spec-driven、no-spec-change，description 为正典字面。
    #[test]
    fn list_all_puts_both_builtins_first_in_order() {
        let listed = list_all(None, None);
        let rows: Vec<(&str, &str)> = listed.iter().map(|s| (s.name.as_str(), s.source)).collect();
        assert_eq!(rows, [("spec-driven", "package"), ("no-spec-change", "package")]);
        assert_eq!(listed[1].description.as_deref(), Some(NO_SPEC_CHANGE_DESCRIPTION));
        assert_eq!(listed[1].artifact_ids, ["proposal", "design", "tasks"]);
    }

    /// 项目层同名 schema 屏蔽内置：解析回项目层，来源依串行出 project 与被屏蔽的内置。
    #[test]
    fn a_project_schema_shadows_the_builtin_of_the_same_name() {
        let root = std::env::temp_dir()
            .join(format!("specseal-schema-shadow-{}", std::process::id()));
        let dir = root.join("openspec").join("schemas").join("no-spec-change");
        std::fs::create_dir_all(&dir).expect("create schema dir");
        std::fs::write(
            dir.join("schema.yaml"),
            "name: no-spec-change\nversion: 1\nartifacts:\n- id: plan\n  generates: plan.md\n  description: The plan\n  template: plan.md\n",
        )
        .expect("write schema.yaml");
        let ws = Workspace { root: root.clone(), spec_dir_name: "openspec".to_string() };

        let s = resolve_with(Some(&ws), None, "no-spec-change")
            .expect("找得到")
            .expect("项目层可加载");
        assert_eq!(s.source, "project");
        assert_eq!(s.artifact_ids(), ["plan"]);
        let layers: Vec<(&str, bool)> = sources(Some(&ws), None, "no-spec-change")
            .iter()
            .map(|s| (s.source, s.path.is_some()))
            .collect();
        assert_eq!(layers, [("project", true), ("built-in", false)]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn design_cross_reference_guidance_says_the_ordinal_alone_counts() {
        // analyzer 只要编号（D1／Decision 1／决策一）出现就算引用；指引不讲，
        // 起草的人会照抄整串标题，design 改一个字 tasks 就跟着红。
        assert!(
            SPEC_DRIVEN_SCHEMA_YAML
                .contains("either its text or just its ordinal (`D1`, `Decision 1`, `决策一`)"),
            "fork.schema.yaml 的 design 交叉引用指引须说明只写编号也算引用"
        );
        // 同段第一句（需求名以子字符串出现）不动。
        assert!(
            SPEC_DRIVEN_SCHEMA_YAML.contains(
                "Every `### Requirement:` name from specs MUST appear as a case-insensitive substring in at least one task description"
            ),
            "需求名那一句逐字不变"
        );
    }
}
