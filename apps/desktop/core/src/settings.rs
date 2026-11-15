//! 设置读写桥接：`.specseal.yaml`（tools）与 `openspec/config.yaml`（政策字段）
//! 的加载快照与双重验证写入（design D5）。纯函数部分在 specseal-core（config.rs
//! 的 update_*_text）；文件读写、写前后验证与技能同步在本层。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use specseal_core::config::{AppConfig, ToolEntry, WorkflowConfig};
use specseal_core::skills::Tool;
use specseal_core::workspace::Workspace;

// Tauri 壳经本 crate 取用政策字段与 context 三态类型，不直接依赖 specseal-core。
pub use specseal_core::config::{
    ContentEdit, ContextEdit, ReviewConfig, SubagentModelConfig, WorkflowPolicyFields,
};

/// 设置页加载快照：两档各自的字段现值与可选的解析错误。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    /// 规格文件夹的项目根相对路径（`specseal`、旧布局 `openspec` 或明写的 spec_dir）——
    /// 设置页文件注记与分类栏组名由它组成（desktop-spec-dir-migration D4）。
    pub spec_dir: String,
    pub app: AppSettings,
    pub workflow: WorkflowSettings,
}

/// `.specseal.yaml` 面：内置工具选集与自订描述子的存在标记。
/// `parse_error` 有值＝文件存在但解析失败——前端停用该档表单并拒写。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub tools: Vec<String>,
    pub custom_tools: Vec<String>,
    pub parse_error: Option<String>,
}

/// `openspec/config.yaml` 面：呈现文件内的原始字段值（非四层 resolve 后的
/// 有效政策——GUI 编辑的对象是这份文件）。未设置的字段呈默认值状态。
/// `context`／`rules` 为「项目说明」「产出规则」的现值；`schema_artifacts`
/// 为活跃 schema 的 artifact id（引擎显示序），是产出规则分节的固定键来源
/// ——解析失败时给空（表单停用，不在坏档上呈现猜测的分节）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSettings {
    pub locale: Option<String>,
    pub spec_locale: Option<String>,
    pub tdd: bool,
    pub audit: bool,
    pub worktree: bool,
    pub context: Option<String>,
    pub rules: BTreeMap<String, Vec<String>>,
    /// 「审查规则」页的现值；未写 review 时为缺省（extend 与三个空清单）。
    pub review: ReviewConfig,
    /// 审查技能 smell baseline 的 12 个名称，由引擎单一提供——前端只显示、不另存。
    pub review_baseline_smells: Vec<String>,
    /// 「子代理模型」页的现值；未写 subagent_model 时为三个空 map。
    pub subagent_model: SubagentModelConfig,
    /// 引擎的内置子代理模型清单（工具名称 → 名称），由引擎单一提供——前端只显示、不另存。
    pub builtin_subagent_models: BTreeMap<String, Vec<String>>,
    pub schema_artifacts: Vec<String>,
    /// 活跃 schema 名称（config 的 schema 键；缺席时缺省 spec-driven）——
    /// 产出流程节下拉的现值。坏档时给空字符串（不呈现猜测值）。
    pub schema_name: String,
    /// false ＝ remote 快照遇非内置 schema 名称（远程自订尚不支持）；其余情境
    /// 一律 true（desktop-schema-panel design D3）。
    pub schema_known: bool,
    pub parse_error: Option<String>,
}

/// 读取设置页快照。三态各自独立：文件缺席＝默认值状态（无 parse_error）；
/// 可解析＝实际字段值；解析失败＝parse_error 单行消息。加载经引擎下沉后的
/// typed 函数（`AppConfig::load`／`WorkflowConfig::from_text` 已 fail-closed，
/// 本层不再自行严格解析绕道）。
pub fn read_settings_at(root: &Path) -> Result<SettingsSnapshot, String> {
    let (ws, app) = match Workspace::discover(root) {
        Ok(None) => return Err(format!("not a specseal project: {}", root.display())),
        Ok(Some(ws)) => {
            let app = match AppConfig::load(&ws.app_config()) {
                Ok(cfg) => {
                    let mut tools = Vec::new();
                    let mut custom_tools = Vec::new();
                    for entry in &cfg.tools {
                        match entry {
                            ToolEntry::Builtin(name) => {
                                if let Some(t) = Tool::parse(name) {
                                    let canonical = t.name().to_string();
                                    if !tools.contains(&canonical) {
                                        tools.push(canonical);
                                    }
                                }
                            }
                            ToolEntry::Descriptor(d) => custom_tools
                                .push(d.name.clone().unwrap_or_else(|| "(unnamed)".to_string())),
                        }
                    }
                    AppSettings { tools, custom_tools, parse_error: None }
                }
                Err(e) => AppSettings {
                    tools: Vec::new(),
                    custom_tools: Vec::new(),
                    parse_error: Some(single_line(&e.reason)),
                },
            };
            (ws, app)
        }
        // 坏 .specseal.yaml：discover fail-closed。设置页沿用既有 UI——app 面
        // 浮出 parse_error（表单停用），workflow 面以缺省布局照常呈现。
        Err(e) => (
            Workspace {
                root: root.to_path_buf(),
                spec_dir_name: specseal_core::workspace::resolve_spec_dir(root, None).0,
            },
            AppSettings {
                tools: Vec::new(),
                custom_tools: Vec::new(),
                parse_error: Some(single_line(&e.reason)),
            },
        ),
    };
    let workflow = workflow_settings_from_text(
        read_opt(&workflow_config_path(&ws)).as_deref(),
        Some(&ws),
    );
    Ok(SettingsSnapshot { spec_dir: ws.spec_dir_name, app, workflow })
}

/// 从 server `/config` 或本机文件原文创建 workflow 设置快照。此入口不读档、
/// 不依赖 checkout，让 local/remote 共用完全相同的字段缺省与 parse-error 语意。
pub fn read_workflow_settings_from_text(text: Option<&str>) -> WorkflowSettings {
    workflow_settings_from_text(text, None)
}

fn workflow_settings_from_text(
    text: Option<&str>,
    workspace: Option<&Workspace>,
) -> WorkflowSettings {
    match WorkflowConfig::from_text(text) {
        // 缺席与可解析同一 arm：缺档的 typed 加载即默认值状态。
        Ok(cfg) => {
            let (schema_artifacts, schema_known) = schema_resolution(workspace, &cfg);
            WorkflowSettings {
                locale: cfg.locale.clone(),
                spec_locale: cfg.spec_locale.clone(),
                tdd: cfg.tdd.unwrap_or(false),
                audit: cfg.audit.unwrap_or(false),
                worktree: cfg.worktree.unwrap_or(false),
                context: cfg.context.clone(),
                rules: cfg.rules.clone(),
                review: cfg.review(),
                review_baseline_smells: review_baseline_smells(),
                subagent_model: cfg.subagent_model(),
                builtin_subagent_models: builtin_subagent_models(),
                schema_artifacts,
                schema_name: cfg.schema_name(),
                schema_known,
                parse_error: None,
            }
        }
        Err(e) => WorkflowSettings {
            locale: None,
            spec_locale: None,
            tdd: false,
            audit: false,
            worktree: false,
            context: None,
            rules: Default::default(),
            review: ReviewConfig::default(),
            review_baseline_smells: review_baseline_smells(),
            subagent_model: SubagentModelConfig::default(),
            builtin_subagent_models: builtin_subagent_models(),
            // 坏档无从得知活跃 schema——不呈现猜测的分节（表单一并停用）。
            schema_artifacts: Vec::new(),
            schema_name: String::new(),
            schema_known: true,
            parse_error: Some(single_line(&e.reason)),
        },
    }
}

fn review_baseline_smells() -> Vec<String> {
    specseal_core::skills::REVIEW_BASELINE_SMELLS.iter().map(|name| name.to_string()).collect()
}

fn builtin_subagent_models() -> BTreeMap<String, Vec<String>> {
    specseal_core::config::BUILTIN_SUBAGENT_MODELS
        .iter()
        .map(|(tool, names)| (tool.to_string(), names.iter().map(|name| name.to_string()).collect()))
        .collect()
}

/// 活跃 schema 的解析结果：artifact id 图（引擎显示序＝`status::display_order`
/// 的拓扑序，与 status 输出一致）＋ schemaKnown。解析失败或找不到时图给空——
/// 与坏档同语意：不在未知 schema 上呈现猜测的固定键。
///
/// local（workspace Some）维持三层解析；remote（None）仅对内置——user 层目录
/// 不参与，client 本机的同名 schema 对 remote 快照零影响（design D3：修掉以
/// 本机 user 层解析 server 项目 schema 名称的怪癖）。remote 遇非内置名称即
/// schemaKnown false（远程自订尚不支持），不是错误。
fn schema_resolution(ws: Option<&Workspace>, cfg: &WorkflowConfig) -> (Vec<String>, bool) {
    let user_dir = ws.map(|_| specseal_host::context::global_config_dir());
    match specseal_core::schema::resolve_with(ws, user_dir.as_deref(), &cfg.schema_name()) {
        Some(Ok(schema)) => (
            specseal_core::status::display_order(&schema)
                .into_iter()
                .map(|a| a.id.clone())
                .collect(),
            true,
        ),
        Some(Err(_)) => (Vec::new(), true),
        None => (Vec::new(), ws.is_some()),
    }
}

/// 产出流程清单的一项（desktop-schema-panel design D1）：名称、来源层级、
/// artifact 图（引擎显示序，与产出规则分节固定键同源）与各 artifact 全文。
/// `error` 有值＝该 schema 解析失败——坏项标记错误而不拖垮整份快照，内容字段
/// 一律空（不呈现猜测值，沿 parse-error 语意）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaEntry {
    pub name: String,
    /// "package"（内置）| "project" | "user"
    pub source: String,
    pub artifact_ids: Vec<String>,
    pub artifacts: Vec<SchemaArtifactDetail>,
    /// schema 目录的绝对路径（打开所在文件夹的把手）；内置在 binary 内为 None。
    /// user 层路径由本层以 global_config_dir 解析，前端不自行拼路径（design D6）。
    pub path: Option<String>,
    pub error: Option<String>,
}

/// 一个 artifact 的唯读详情：description／instruction／template 全文。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaArtifactDetail {
    pub id: String,
    pub description: String,
    pub instruction: Option<String>,
    pub template: Option<String>,
}

/// local 入口：discover 项目根后三层（内置→项目→user）组装产出流程快照。
pub fn read_schemas_at(root: &Path) -> Result<Vec<SchemaEntry>, String> {
    let ws = discover(root)?;
    Ok(schemas_snapshot(Some(&ws), Some(&specseal_host::context::global_config_dir())))
}

/// remote 面数据源：只有内嵌内置，不读任何磁盘层（design D3 的限缩）。
pub fn builtin_schemas() -> Vec<SchemaEntry> {
    schemas_snapshot(None, None)
}

/// 快照组装本体：内置先、项目层次之、user 层最后（各层目录名排序，与引擎
/// `list_all` 同序）。逐目录走引擎 `load_dir` 解析——同名跨层各自成项、内容
/// 各自正确（`resolve_with` 只回第一命中，对被 shadow 的层会答错内容）。
fn schemas_snapshot(ws: Option<&Workspace>, user_dir: Option<&Path>) -> Vec<SchemaEntry> {
    let mut out: Vec<SchemaEntry> = specseal_core::schema::builtin_names()
        .filter_map(specseal_core::schema::builtin)
        .map(|schema| schema_entry(&schema))
        .collect();
    for (dir, src) in specseal_core::schema::schema_dirs(ws, user_dir) {
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map(|it| {
                it.flatten()
                    .filter(|e| e.path().join("schema.yaml").is_file())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        for name in names {
            let schema_dir = dir.join(&name);
            let path = Some(schema_dir.to_string_lossy().into_owned());
            out.push(match specseal_core::schema::load_dir(&schema_dir, &name, src) {
                Ok(schema) => SchemaEntry { path, ..schema_entry(&schema) },
                Err(e) => SchemaEntry {
                    name,
                    source: src.to_string(),
                    artifact_ids: Vec::new(),
                    artifacts: Vec::new(),
                    path,
                    error: Some(single_line(&e)),
                },
            });
        }
    }
    out
}

/// 切换项目 schema（design D2 的 local 写入）：schema 键经引擎 byte-preserving
/// setter 改写（其余内容逐字节保留、坏档拒写），写档后回读验证键值——沿本层
/// 双重验证惯例，任一步失败回单行 Err、磁盘文件维持原内容。
pub fn write_workflow_schema_at(root: &Path, name: &str) -> Result<(), String> {
    let ws = discover(root)?;
    let file = format!("{}/config.yaml", ws.spec_dir_name);
    let path = workflow_config_path(&ws);
    let original = read_opt(&path);
    let new_text = specseal_core::config::set_workflow_schema_text(original.as_deref(), name)
        .map_err(|e| single_line(&e.to_string()))?;
    specseal_core::util::write_file(&path, &new_text)
        .map_err(|e| format!("{file}: write failed: {e}"))?;
    let reread = read_opt(&path)
        .ok_or_else(|| format!("{file}: verify after write failed: file unreadable"))?;
    let cfg = WorkflowConfig::from_text(Some(&reread))
        .map_err(|e| format!("{file}: verify after write failed: {}", single_line(&e.reason)))?;
    if cfg.schema_name() == name {
        Ok(())
    } else {
        Err(format!("{file}: verify after write failed: rewritten values do not match the request"))
    }
}

/// 创建新的自订 schema 骨架（design D5；引擎既有 init_schema 函数）：artifact
/// 布局与描述用引擎缺省，名称验证（kebab-case）与已存在检查都在引擎、错误
/// 原样上抛。内容客制交外部编辑器，desktop 不做编辑器。
pub fn init_schema_at(root: &Path, name: &str) -> Result<(), String> {
    let ws = discover(root)?;
    specseal_core::schema::init_schema(&ws, name, None, None, false).map(|_| ())
}

/// 删除项目层的自订 schema（design D7）：目标由名称固定解析为项目
/// openspec/schemas/<name>——不收任意路径（也因此 user 层与内置不受理）；
/// 名称先过本层的字符门（kebab-case 字符集的超集检查，错误消息与引擎同款），
/// `..` 之类的路径片段到不了 remove_dir_all。config 的 schema 键正指着它
/// （使用中）拒删；目录不存在拒删。
///
/// 错误消息语言：用户决策型消息用繁中（沿 refuse_teardown_with_active_worktrees
/// 的先例）；机械验证格式（write/verify failed）维持同档英文惯例。
pub fn delete_schema_at(root: &Path, name: &str) -> Result<(), String> {
    let ws = discover(root)?;
    // 字符门足以挡掉 `..`、`/` 等路径片段（kebab-case 的超集检查；完整规则
    // 属引擎，这里只守「名称不是路径」的安全不变量）。
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(format!(
            "Invalid schema name '{name}': must be lowercase kebab-case (e.g. my-flow)"
        ));
    }
    let active = WorkflowConfig::from_text(read_opt(&workflow_config_path(&ws)).as_deref())
        .map(|cfg| cfg.schema_name())
        .map_err(|e| single_line(&e.reason))?;
    if active == name {
        return Err(format!(
            "'{name}' 是使用中的产出流程（config.yaml 的 schema 键正指着它）——请先切换到其他项目再删除"
        ));
    }
    let target = ws.spec_dir().join("schemas").join(name);
    if !target.join("schema.yaml").is_file() {
        return Err(format!("项目层没有名为 '{name}' 的产出流程"));
    }
    std::fs::remove_dir_all(&target).map_err(|e| format!("删除 '{name}' 失败：{e}"))
}

/// fork 选中的 schema 到项目 openspec/schemas/（design D2；引擎既有 fork 函数，
/// 目标已存在等错误原样上抛）。复本名固定为引擎缺省 `<source>-custom`——UI 不收
/// 自订名（review R2）。回传新 schema 名称。
pub fn fork_schema_at(root: &Path, source: &str) -> Result<String, String> {
    let ws = discover(root)?;
    specseal_core::schema::fork(
        &ws,
        Some(&specseal_host::context::global_config_dir()),
        source,
        None,
        false,
    )
}

fn schema_entry(schema: &specseal_core::schema::Schema) -> SchemaEntry {
    let ordered = specseal_core::status::display_order(schema);
    SchemaEntry {
        name: schema.name.clone(),
        source: schema.source.clone(),
        artifact_ids: ordered.iter().map(|a| a.id.clone()).collect(),
        artifacts: ordered
            .iter()
            .map(|a| SchemaArtifactDetail {
                id: a.id.clone(),
                description: a.description.clone(),
                instruction: a.instruction.clone(),
                template: a.template.clone(),
            })
            .collect(),
        path: None,
        error: None,
    }
}

/// 纯文本政策字段改写 seam。代换 locale/spec_locale/tdd/audit/worktree，其他键的
/// parsed value 保持不变；设回默认值时移除键。输出在回传前再经 typed 验证。
pub fn rewrite_workflow_fields_text(
    original: &str,
    fields: &WorkflowPolicyFields,
) -> Result<String, String> {
    rewrite_workflow_fields_text_for(original, fields, "config.yaml")
}

fn rewrite_workflow_fields_text_for(
    original: &str,
    fields: &WorkflowPolicyFields,
    file: &str,
) -> Result<String, String> {
    let new_text = specseal_core::config::update_workflow_config_text(
        original,
        fields,
        &ContentEdit::default(),
    )
    .map_err(|e| single_line(&e.to_string()))?;
    verify_workflow_text(&new_text, fields, file, "rewrite verification")?;
    Ok(new_text)
}

/// 写入 `openspec/config.yaml` 的政策字段（design D5 双重验证）：core 纯函数
/// 改写（写前解析原文失败即中止）→ 验证新文本可解析且目标字段值正确 →
/// 写档 → 回读再验。任一步失败回指明文件与阶段的单行 Err，磁盘文件维持原内容
/// ——绝不留下不可解析的设置档。
///
/// `fields` 是设置页可编辑字段的完整目标状态（非 patch）：调用端必须先以
/// `read_settings_at` 取得现值再改写，否则留在缺省的字段会被清掉。
///
/// worktree 牵动技能足迹，故与 CLI 的 `workflow-config set` 同序（design D2）：
/// 开→关先查活跃 worktree（有则整体不动），写入成功后同步足迹。
pub fn write_workflow_fields_at(
    root: &Path,
    fields: &specseal_core::config::WorkflowPolicyFields,
) -> Result<(), String> {
    let ws = discover(root)?;
    let file = format!("{}/config.yaml", ws.spec_dir_name);
    let path = workflow_config_path(&ws);
    let original = read_opt(&path).unwrap_or_default();
    let new_text = rewrite_workflow_fields_text_for(&original, fields, &file)?;
    let worktree_was_on = WorkflowConfig::from_text(Some(&original))
        .ok()
        .and_then(|c| c.worktree)
        .unwrap_or(false);
    if worktree_was_on && !fields.worktree {
        refuse_teardown_with_active_worktrees(&ws)?;
    }
    specseal_core::util::write_file(&path, &new_text)
        .map_err(|e| format!("{file}: write failed: {e}"))?;
    let reread = read_opt(&path)
        .ok_or_else(|| format!("{file}: verify after write failed: file unreadable"))?;
    verify_workflow_text(&reread, fields, &file, "verify after write")?;
    // 只同步技能档、不迁移规格文件夹（desktop-spec-dir-migration D6）。
    if worktree_was_on != fields.worktree {
        specseal_core::init::sync_skills(&ws.root).map_err(|e| {
            format!(
                "{file} written, but the skill footprint did not sync: {} — fix the cause above, then re-run `specseal update` to rebuild it",
                single_line(&e.to_string())
            )
        })?;
    }
    Ok(())
}

/// 关闭 worktree 政策会连 merge 技能一起收走，挂着的 worktree 就没有收尾工具了。
/// 与 CLI 走同一个 host 判定，消息列出每个 worktree 的 change 名、分支与路径。
/// git 不可用时判定回空清单（fail-open），不挡。
fn refuse_teardown_with_active_worktrees(ws: &Workspace) -> Result<(), String> {
    let store = specseal_fs::FsStore::new(&ws.root, &ws.spec_dir_name);
    let blockers = specseal_host::worktree::teardown_blockers(ws, &store);
    if blockers.is_empty() {
        return Ok(());
    }
    let list: Vec<String> = blockers
        .iter()
        .map(|b| format!("{} ({}) at {}", b.change, b.branch, b.path.display()))
        .collect();
    Err(format!(
        "worktree 仍在使用中，关闭后将移除收尾用的 merge 技能：{}。请先对每个 worktree 运行 specseal-worktree-merge 收尾，再关闭此开关。",
        list.join("；")
    ))
}

/// 写入 `openspec/config.yaml` 的「项目说明」与「产出规则」（design D4：与政策
/// 字段同一套双重验证流程）：解析原文取政策现值（坏档 loud 中止、文件未动）→
/// core 纯函数改写（政策字段回填现值、不受内容写入波及）→ 验证新文本 → 写档 →
/// 回读再验。任一步失败回指明文件与阶段的单行 Err，磁盘文件维持原内容。
///
/// `rules` 为 `None` 不动 rules；`Some` 为整份代换（节序即写入序，条目 trim、
/// 空条目涤除、空节移除、全空移除 rules 键——清理语意在 core 纯函数落实）。
/// `review` 同理：`None` 不动，`Some` 为整块代换（移除语意与 CLI 的
/// `workflow-config review` 一致，同样在 core 落实）。
pub fn write_workflow_content_at(root: &Path, edit: &ContentEdit) -> Result<(), String> {
    let ws = discover(root)?;
    let file = format!("{}/config.yaml", ws.spec_dir_name);
    let path = workflow_config_path(&ws);
    let original = read_opt(&path).unwrap_or_default();
    let new_text = rewrite_workflow_content_text_for(&original, edit, &file)?;
    let expected = WorkflowConfig::from_text(Some(&new_text)).map_err(|e| {
        format!("{file}: pre-write verification failed: {}", single_line(&e.reason))
    })?;
    let fields = workflow_policy_fields(&expected);
    specseal_core::util::write_file(&path, &new_text)
        .map_err(|e| format!("{file}: write failed: {e}"))?;
    let reread = read_opt(&path)
        .ok_or_else(|| format!("{file}: verify after write failed: file unreadable"))?;
    verify_workflow_content_text(&reread, &ContentExpectation::of(&expected), &fields, &file, "verify after write")
}

/// 纯文本 context/rules/review/subagent_model targeted-key 改写 seam。政策字段从原文读出再原样
/// 回填，让 remote 与 local 共用同一份未触及键与清空移除语意。
pub fn rewrite_workflow_content_text(original: &str, edit: &ContentEdit) -> Result<String, String> {
    rewrite_workflow_content_text_for(original, edit, "config.yaml")
}

fn rewrite_workflow_content_text_for(
    original: &str,
    edit: &ContentEdit,
    file: &str,
) -> Result<String, String> {
    let ContentEdit { context, rules, review, subagent_model } = edit;
    let current = WorkflowConfig::from_text(Some(original)).map_err(|e| {
        format!("{file}: rewrite verification failed: {}", single_line(&e.reason))
    })?;
    let fields = workflow_policy_fields(&current);
    let want = ContentExpectation {
        context: match context {
            ContextEdit::Keep => current.context.clone(),
            ContextEdit::Set(value) if !value.trim().is_empty() => Some(value.clone()),
            ContextEdit::Set(_) | ContextEdit::Remove => None,
        },
        rules: match rules {
            None => current.rules.clone(),
            Some(sections) => sections
                .iter()
                .filter_map(|(key, entries)| {
                    let cleaned = cleaned_entries(entries);
                    (!cleaned.is_empty()).then(|| (key.clone(), cleaned))
                })
                .collect(),
        },
        review: match review {
            None => current.review(),
            Some(r) => ReviewConfig {
                baseline: r.baseline,
                critical: cleaned_entries(&r.critical),
                warning: cleaned_entries(&r.warning),
                suggestion: cleaned_entries(&r.suggestion),
            },
        },
        subagent_model: match subagent_model {
            None => current.subagent_model(),
            Some(s) => cleaned_subagent_model(s),
        },
    };
    let new_text =
        specseal_core::config::update_workflow_config_text(original, &fields, edit)
            .map_err(|e| single_line(&e.to_string()))?;
    verify_workflow_content_text(&new_text, &want, &fields, file, "rewrite verification")?;
    Ok(new_text)
}

/// 一次内容写入后四块内容的期望值（政策字段另由 `WorkflowPolicyFields` 带）。
struct ContentExpectation {
    context: Option<String>,
    rules: BTreeMap<String, Vec<String>>,
    review: ReviewConfig,
    subagent_model: SubagentModelConfig,
}

impl ContentExpectation {
    /// 一份已解析的设置里的四块内容（写后回读以写前解析出的这份为准）。
    fn of(cfg: &WorkflowConfig) -> ContentExpectation {
        ContentExpectation {
            context: cfg.context.clone(),
            rules: cfg.rules.clone(),
            review: cfg.review(),
            subagent_model: cfg.subagent_model(),
        }
    }
}

/// 条目 trim、空条目涤除——与 core 写入接缝相同的清理，作为验证的期望值。
fn cleaned_entries(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// 验证的期望值：让 `SubagentModelConfig` 自己的严格解析做清理（模型值去头尾空白、空值与空
/// 清单丢弃、清单条目去空白）——读回文件时走的也是这套规则，本层不另写一份。
fn cleaned_subagent_model(s: &SubagentModelConfig) -> SubagentModelConfig {
    serde_json::to_value(s)
        .and_then(serde_json::from_value)
        .expect("a SubagentModelConfig round-trips through its own parse")
}

fn workflow_policy_fields(config: &WorkflowConfig) -> WorkflowPolicyFields {
    WorkflowPolicyFields {
        locale: config.locale.clone(),
        spec_locale: config.spec_locale.clone(),
        tdd: config.tdd.unwrap_or(false),
        audit: config.audit.unwrap_or(false),
        // 读回现值而非留 default：目标状态是「完整」的，漏带会让设置页的任一次存盘
        // 静默删掉用户的 worktree 键。桌面尚无此字段的 UI（属第二刀），这里只保值。
        worktree: config.worktree.unwrap_or(false),
    }
}

/// 验证一份 config.yaml 文本可解析，且四块内容与政策字段皆为期望值。
fn verify_workflow_content_text(
    text: &str,
    want: &ContentExpectation,
    fields: &WorkflowPolicyFields,
    file: &str,
    stage: &str,
) -> Result<(), String> {
    let cfg: WorkflowConfig = serde_yaml::from_str(text)
        .map_err(|e| format!("{file}: {stage} failed: {}", single_line(&e.to_string())))?;
    if cfg.context == want.context
        && cfg.rules == want.rules
        && cfg.review() == want.review
        && cfg.subagent_model() == want.subagent_model
        && cfg.locale == fields.locale
        && cfg.spec_locale == fields.spec_locale
        && cfg.tdd.unwrap_or(false) == fields.tdd
        && cfg.audit.unwrap_or(false) == fields.audit
        && cfg.worktree.unwrap_or(false) == fields.worktree
    {
        Ok(())
    } else {
        Err(format!("{file}: {stage} failed: rewritten values do not match the request"))
    }
}

/// 验证一份 config.yaml 文本可解析且政策字段值与请求一致。
fn verify_workflow_text(
    text: &str,
    fields: &specseal_core::config::WorkflowPolicyFields,
    file: &str,
    stage: &str,
) -> Result<(), String> {
    let cfg: WorkflowConfig = serde_yaml::from_str(text)
        .map_err(|e| format!("{file}: {stage} failed: {}", single_line(&e.to_string())))?;
    if cfg.locale == fields.locale
        && cfg.spec_locale == fields.spec_locale
        && cfg.tdd.unwrap_or(false) == fields.tdd
        && cfg.audit.unwrap_or(false) == fields.audit
        && cfg.worktree.unwrap_or(false) == fields.worktree
    {
        Ok(())
    } else {
        Err(format!("{file}: {stage} failed: rewritten values do not match the request"))
    }
}

/// 写入 `.specseal.yaml` 的内置工具选集并同步受管产物。编排全在
/// `specseal_core::init::reconcile_builtin_tools`——设置页、CLI init 与 checkout 绑定
/// 共用同一入口，因此三者对相同选集产生相同结果。未知工具名、空选集与无法解析的
/// 原档都在任何写入之前被拒。
pub fn write_tools_at(root: &Path, tools: &[String]) -> Result<(), String> {
    let ws = discover(root)?;
    let selected =
        specseal_core::init::parse_tool_names(tools).map_err(|e| single_line(&e.to_string()))?;
    specseal_core::init::reconcile_builtin_tools(&ws.root, &selected)
        .map_err(|e| single_line(&e.to_string()))?;
    Ok(())
}

fn discover(root: &Path) -> Result<Workspace, String> {
    Workspace::discover(root)
        .map_err(|e| single_line(&e.to_string()))?
        .ok_or_else(|| format!("not a specseal project: {}", root.display()))
}

fn workflow_config_path(ws: &Workspace) -> PathBuf {
    ws.spec_dir().join("config.yaml")
}

/// 文件缺席回 None；读取失败以外的内容原文回传。
fn read_opt(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// serde_yaml 错误消息压成单行（多行时取首行），符合 Err 单行消息契约。
fn single_line(msg: &str) -> String {
    msg.lines().next().unwrap_or(msg).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testfixture::FixtureRoot;

    // --- read_settings_at：三态读取（文件缺席／可解析／解析失败） ---

    #[test]
    fn read_settings_absent_files_report_defaults_without_parse_error() {
        // FixtureRoot 只建 specseal/changes——两份设置档皆缺席＝默认值状态。
        let fx = FixtureRoot::new("settings-absent");
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(s.app.tools, Vec::<String>::new());
        assert_eq!(s.app.custom_tools, Vec::<String>::new());
        assert_eq!(s.app.parse_error, None);
        assert_eq!(s.workflow.locale, None);
        assert_eq!(s.workflow.spec_locale, None);
        assert!(!s.workflow.tdd);
        assert!(!s.workflow.audit);
        assert_eq!(s.workflow.parse_error, None);
    }

    #[test]
    fn read_settings_reports_the_spec_folder_relative_to_the_root() {
        // spec「画面依实际规格文件夹与数据文件名显示」：设置页的文件注记与分类栏组名由它组成。
        let fx = FixtureRoot::legacy("settings-spec-dir");
        fx.write(".specseal.yaml", "tools: [claude]\n");
        let value = serde_json::to_value(read_settings_at(fx.root()).expect("read ok")).unwrap();
        assert_eq!(value["specDir"], "openspec", "旧布局");
        fx.write(".specseal.yaml", "spec_dir: docs/specs\n");
        std::fs::create_dir_all(fx.root().join("docs/specs")).unwrap();
        assert_eq!(read_settings_at(fx.root()).unwrap().spec_dir, "docs/specs", "明写 spec_dir");
        // 坏 .specseal.yaml：依实际布局推断，不写死 openspec。
        fx.write(".specseal.yaml", "tools: [\n");
        std::fs::rename(fx.root().join("openspec"), fx.root().join("specseal")).unwrap();
        assert_eq!(read_settings_at(fx.root()).unwrap().spec_dir, "specseal", "坏设置");
    }

    #[test]
    fn read_settings_parses_actual_values_and_flags_custom_descriptors() {
        let fx = FixtureRoot::new("settings-values");
        fx.write(
            ".specseal.yaml",
            "tools:\n  - claude\n  - name: wad-harness\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\n",
        );
        fx.write(
            "specseal/config.yaml",
            "schema: spec-driven\nlocale: tw\nspec_locale: auto\ntdd: true\naudit: true\n",
        );
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(s.app.tools, vec!["claude".to_string()]);
        assert_eq!(s.app.custom_tools, vec!["wad-harness".to_string()]);
        assert_eq!(s.app.parse_error, None);
        assert_eq!(s.workflow.locale.as_deref(), Some("tw"));
        assert_eq!(s.workflow.spec_locale.as_deref(), Some("auto"));
        assert!(s.workflow.tdd);
        assert!(s.workflow.audit);
        assert_eq!(s.workflow.parse_error, None);
    }

    #[test]
    fn read_settings_surfaces_parse_errors_instead_of_silent_defaults() {
        // 对比引擎的静默 fallback：GUI 加载必须把解析失败浮出（spec 需求
        // 「设置写入具解析验证且失败浮出」的加载面）。两档各自独立。
        let fx = FixtureRoot::new("settings-badwf");
        fx.write(".specseal.yaml", "tools:\n  - claude\n");
        fx.write("specseal/config.yaml", "rules: [unclosed\n");
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(s.app.parse_error, None);
        let msg = s.workflow.parse_error.expect("workflow parse error surfaced");
        assert!(!msg.is_empty() && !msg.contains('\n'), "single line: {msg:?}");

        let fx = FixtureRoot::new("settings-badapp");
        fx.write(".specseal.yaml", "tools: [unclosed\n");
        fx.write("specseal/config.yaml", "locale: tw\n");
        let s = read_settings_at(fx.root()).expect("read ok");
        let msg = s.app.parse_error.expect("app parse error surfaced");
        assert!(!msg.is_empty() && !msg.contains('\n'), "single line: {msg:?}");
        assert_eq!(s.workflow.parse_error, None);
        assert_eq!(s.workflow.locale.as_deref(), Some("tw"));
    }

    #[test]
    fn read_settings_outside_a_project_is_an_error() {
        let dir = std::env::temp_dir();
        assert!(read_settings_at(&dir).is_err());
    }

    #[test]
    fn read_workflow_settings_from_text_parses_every_remote_editable_field() {
        let settings = read_workflow_settings_from_text(Some(
            "schema: spec-driven\nlocale: tw\nspec_locale: auto\ntdd: true\naudit: true\ncontext: 项目说明\nrules:\n  tasks:\n    - 完成后验证\n",
        ));
        assert_eq!(settings.locale.as_deref(), Some("tw"));
        assert_eq!(settings.spec_locale.as_deref(), Some("auto"));
        assert!(settings.tdd);
        assert!(settings.audit);
        assert_eq!(settings.context.as_deref(), Some("项目说明"));
        assert_eq!(settings.rules["tasks"], ["完成后验证"]);
        assert_eq!(settings.schema_artifacts, SPEC_DRIVEN_IDS);
        assert_eq!(settings.parse_error, None);
    }

    // spec Example「政策字段写入效果」row 1。
    #[test]
    fn text_rewrite_adds_tdd_true_when_the_key_is_absent() {
        let fields = WorkflowPolicyFields { tdd: true, ..Default::default() };
        let output = rewrite_workflow_fields_text("schema: spec-driven\n", &fields)
            .expect("rewrite");
        let parsed = WorkflowConfig::from_text(Some(&output)).expect("parse output");
        assert_eq!(parsed.tdd, Some(true));
    }

    // spec Example「政策字段写入效果」row 2。
    #[test]
    fn text_rewrite_removes_tdd_when_reset_to_the_default() {
        let output = rewrite_workflow_fields_text(
            "schema: spec-driven\ntdd: true\n",
            &WorkflowPolicyFields::default(),
        )
        .expect("rewrite");
        let mapping: serde_yaml::Mapping = serde_yaml::from_str(&output).expect("mapping");
        assert!(!mapping.contains_key("tdd"), "default false removes the key: {output}");
    }

    // spec Example「政策字段写入效果」row 3。
    #[test]
    fn text_rewrite_adds_spec_locale_and_preserves_locale_and_rules_values() {
        let original = "locale: tw\nrules:\n  proposal:\n    - keep\n";
        let fields = WorkflowPolicyFields {
            locale: Some("tw".into()),
            spec_locale: Some("auto".into()),
            ..Default::default()
        };
        let output = rewrite_workflow_fields_text(original, &fields).expect("rewrite");
        let before = WorkflowConfig::from_text(Some(original)).expect("parse before");
        let after = WorkflowConfig::from_text(Some(&output)).expect("parse after");
        assert_eq!(after.spec_locale.as_deref(), Some("auto"));
        assert_eq!(after.locale, before.locale);
        assert_eq!(after.rules, before.rules);
    }

    #[test]
    fn text_rewrite_writes_the_worktree_value_the_page_sent() {
        // 设置页有了 worktree 开关，送来的值就是目标状态（不再从原档回填）：
        // 开→关要真的把键拿掉，否则画面上关了、文件里还开着。
        let off = rewrite_workflow_fields_text(
            "schema: spec-driven\nworktree: true\n",
            &WorkflowPolicyFields { tdd: true, ..Default::default() },
        )
        .expect("rewrite");
        let parsed = WorkflowConfig::from_text(Some(&off)).expect("parse output");
        assert_eq!(parsed.worktree, None, "关闭时键应被移除（false＝缺省）：{off}");
        assert_eq!(parsed.tdd, Some(true));

        let on = rewrite_workflow_fields_text(
            "schema: spec-driven\n",
            &WorkflowPolicyFields { worktree: true, ..Default::default() },
        )
        .expect("rewrite");
        let parsed = WorkflowConfig::from_text(Some(&on)).expect("parse output");
        assert_eq!(parsed.worktree, Some(true), "打开时键应写入：{on}");
    }

    #[test]
    fn content_text_rewrite_preserves_policy_and_the_untouched_rules_value() {
        let original = "schema: spec-driven\nlocale: tw\ntdd: true\ncontext: old\nrules:\n  tasks:\n    - keep me\n";
        let output = rewrite_workflow_content_text(
            original,
            &ContentEdit { context: ContextEdit::Set("new context".into()), ..Default::default() },
        )
        .expect("rewrite");
        let before = WorkflowConfig::from_text(Some(original)).expect("parse before");
        let after = WorkflowConfig::from_text(Some(&output)).expect("parse after");
        assert_eq!(after.context.as_deref(), Some("new context"));
        assert_eq!(after.rules, before.rules);
        assert_eq!(after.locale, before.locale);
        assert_eq!(after.tdd, before.tdd);
    }

    // --- 写入：双重验证与失败浮出（spec 需求「设置写入具解析验证且失败浮出」） ---

    use specseal_core::config::WorkflowPolicyFields;
    use std::path::Path;

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn set_readonly(path: &Path, ro: bool) {
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_readonly(ro);
        std::fs::set_permissions(path, perms).unwrap();
    }

    /// 让写档阶段必定失败。unix 上原子写的暂存盘看目录权限、退回的直写看文件
    /// 权限——两者都锁才逼得出失败；Windows 的 rename 覆盖唯读档与直写唯读档
    /// 都会被拒，锁文件即可。
    fn block_writes(path: &Path, blocked: bool) {
        #[cfg(unix)]
        set_readonly(path.parent().unwrap(), blocked);
        set_readonly(path, blocked);
    }

    #[test]
    fn write_workflow_fields_replaces_targets_and_keeps_untouched_keys() {
        // spec Scenario「写入政策字段且未触及键原样保留」。
        let fx = FixtureRoot::new("wf-write");
        let doc = "schema: spec-driven\ncontext: |\n  keep me\nrules:\n  proposal:\n    - keep rule\n";
        fx.write("specseal/config.yaml", doc);
        let fields = WorkflowPolicyFields { tdd: true, ..Default::default() };
        write_workflow_fields_at(fx.root(), &fields).expect("write ok");
        // 手术改写：tdd 插于 schema 之下、前后恰一空行，其余行逐比特保留（不再整档重排）。
        assert_eq!(
            read(&fx.root().join("specseal/config.yaml")),
            "schema: spec-driven\n\ntdd: true\n\ncontext: |\n  keep me\nrules:\n  proposal:\n    - keep rule\n"
        );
    }

    #[test]
    fn write_workflow_fields_leaves_no_temp_residue() {
        // spec Scenario「设置写入走同一原子入口」的观察面：写入成功后目录无暂存
        // 残留、内容为完整全文（收编一旦回归普通 fs::write 前者仍绿，但残留断言
        // 钉住原子入口的成功路径契约）。
        let fx = FixtureRoot::new("wf-write-atomic-face");
        fx.write("specseal/config.yaml", "schema: spec-driven\n");
        let fields = WorkflowPolicyFields { tdd: true, ..Default::default() };
        write_workflow_fields_at(fx.root(), &fields).expect("write ok");
        let residue: Vec<String> = std::fs::read_dir(fx.root().join("specseal"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(residue.is_empty(), "temp residue left behind: {residue:?}");
        let text = read(&fx.root().join("specseal/config.yaml"));
        assert!(
            text.contains("schema: spec-driven") && text.contains("tdd: true"),
            "content is the complete new document: {text}"
        );
    }

    #[test]
    fn write_refuses_to_turn_worktree_off_while_one_is_active() {
        // spec Scenario「关闭遇活跃 worktree 浮出挡下」：消息列出 change 名、分支
        // 与路径并指出收尾方式，config 档逐比特不变。
        // fixture 的 attach_worktree 会写入 worktree: true 的 config 并回报 git
        // 拼法的路径——消息里的路径同样来自 git，期望与其同源才对得上。
        let fx = FixtureRoot::new("wf-write-wt-block");
        fx.add_change("add-auth", "");
        let wt = fx.attach_worktree("add-auth");
        let before = read(&fx.root().join("specseal/config.yaml"));

        let err = write_workflow_fields_at(fx.root(), &WorkflowPolicyFields::default())
            .expect_err("有活跃 worktree 时必须拒绝");

        assert!(err.contains("add-auth"), "须列 change 名: {err}");
        assert!(err.contains("specseal/add-auth"), "须列分支: {err}");
        assert!(err.contains(wt.path().to_str().unwrap()), "须列路径: {err}");
        assert!(err.contains("worktree-merge"), "须指出收尾方式: {err}");
        assert_eq!(read(&fx.root().join("specseal/config.yaml")), before, "文件不得变动");
    }

    #[test]
    fn toggling_worktree_on_a_legacy_layout_never_moves_the_spec_folder() {
        // spec「技能足迹同步不迁移规格文件夹」Scenario「桌面切换 worktree 不迁移」：迁移只走
        // 技能档提示的「更新」（会暂停监看、说明改名）。
        let fx = FixtureRoot::legacy("wf-write-wt-legacy");
        fx.write(".specseal.yaml", "tools: [claude]\n");
        fx.write("openspec/changes/demo/.openspec.yaml", "schema: spec-driven\n");
        let fields = WorkflowPolicyFields { worktree: true, ..WorkflowPolicyFields::default() };
        write_workflow_fields_at(fx.root(), &fields).expect("write ok");
        assert!(fx.root().join("openspec/changes/demo/.openspec.yaml").is_file(), "openspec/ 原封不动");
        assert!(!fx.root().join("specseal").exists());
        for skill in ["specseal-apply-with-worktree", "specseal-worktree-merge"] {
            assert!(fx.root().join(".claude/skills").join(skill).join("SKILL.md").is_file(), "{skill}");
        }
    }

    #[test]
    fn write_turns_worktree_off_when_none_is_active() {
        // 无活跃 worktree（此 fixture 连 git repo 都不是）＝ fail-open，照常写入。
        let fx = FixtureRoot::new("wf-write-wt-free");
        fx.write("specseal/config.yaml", "schema: spec-driven\nworktree: true\n");
        write_workflow_fields_at(fx.root(), &WorkflowPolicyFields::default()).expect("write ok");
        let text = read(&fx.root().join("specseal/config.yaml"));
        let parsed = WorkflowConfig::from_text(Some(&text)).expect("parse");
        assert_eq!(parsed.worktree, None, "关闭后键应被移除: {text}");
    }

    #[test]
    fn write_workflow_fields_creates_config_when_absent() {
        let fx = FixtureRoot::new("wf-write-fresh");
        let fields = WorkflowPolicyFields { locale: Some("tw".into()), ..Default::default() };
        write_workflow_fields_at(fx.root(), &fields).expect("write ok");
        let text = read(&fx.root().join("specseal/config.yaml"));
        let new: WorkflowConfig = serde_yaml::from_str(&text).expect("output parses");
        assert_eq!(new.locale.as_deref(), Some("tw"));
    }

    #[test]
    fn write_workflow_fields_refuses_unparseable_original_and_leaves_file_intact() {
        // spec Scenario「解析失败的文件拒绝写入」＋「写入验证失败文件不变」的写前面。
        let fx = FixtureRoot::new("wf-write-bad");
        let bad = "rules: [unclosed\n";
        fx.write("specseal/config.yaml", bad);
        let err = write_workflow_fields_at(fx.root(), &WorkflowPolicyFields::default())
            .expect_err("must refuse");
        assert!(err.contains("config.yaml"), "must name the file: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert_eq!(read(&fx.root().join("specseal/config.yaml")), bad, "file must be untouched");
    }

    #[test]
    fn write_workflow_fields_surfaces_write_failure_with_file_and_stage() {
        // 挡下写入触发写档阶段失败：Err 指明文件与阶段、内容逐字符不变。
        let fx = FixtureRoot::new("wf-write-ro");
        let doc = "locale: tw\n";
        fx.write("specseal/config.yaml", doc);
        let path = fx.root().join("specseal/config.yaml");
        block_writes(&path, true);
        let err = write_workflow_fields_at(fx.root(), &WorkflowPolicyFields::default())
            .expect_err("must fail");
        block_writes(&path, false);
        assert!(err.contains("config.yaml"), "must name the file: {err}");
        assert!(err.contains("write"), "must name the stage: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert_eq!(read(&path), doc, "file must be untouched");
    }

    #[test]
    fn write_tools_syncs_skills_for_newly_selected_codex() {
        // spec Scenario「tools 变更后技能同步」：加选 codex 生成 .agents/skills/
        // 而无 AGENTS.md。从 init 过的 claude 项目出发。
        let fx = FixtureRoot::new("tools-write-add");
        std::fs::remove_dir_all(fx.root().join("specseal")).unwrap();
        crate::project::init_project_at(fx.root(), &["claude".into()]).expect("init ok");
        write_tools_at(fx.root(), &["claude".into(), "codex".into()]).expect("write ok");
        let app = read(&fx.root().join(".specseal.yaml"));
        assert!(app.contains("claude") && app.contains("codex"), "tools recorded: {app}");
        assert!(!fx.root().join("AGENTS.md").exists(), "指令档不得生成");
        assert!(fx.root().join(".agents").join("skills").is_dir());
    }

    #[test]
    fn write_tools_adds_then_prunes_copilot_skills() {
        // spec Scenario「加选与取消 copilot 后技能同步」：加选生成 .github/skills/，
        // 取消后 specseal- 目录全数移除，.github/ 下其他文件不动。
        let fx = FixtureRoot::new("tools-write-copilot");
        std::fs::remove_dir_all(fx.root().join("specseal")).unwrap();
        crate::project::init_project_at(fx.root(), &["claude".into()]).expect("init ok");
        let workflow = fx.root().join(".github").join("workflows").join("ci.yml");
        std::fs::create_dir_all(workflow.parent().unwrap()).unwrap();
        std::fs::write(&workflow, "on: push\n").unwrap();
        let skills = fx.root().join(".github").join("skills");

        write_tools_at(fx.root(), &["claude".into(), "copilot".into()]).expect("add ok");
        let app = read(&fx.root().join(".specseal.yaml"));
        assert!(
            app.contains("claude") && app.contains("copilot"),
            "tools recorded: {app}"
        );
        assert!(skills.join("specseal-propose").join("SKILL.md").is_file());

        write_tools_at(fx.root(), &["claude".into()]).expect("remove ok");
        let app = read(&fx.root().join(".specseal.yaml"));
        assert!(!app.contains("copilot"), "tools recorded: {app}");
        assert!(!skills.exists(), "变空的 .github/skills/ 须移除");
        assert_eq!(read(&workflow), "on: push\n", ".github/ 下其他文件不得变动");
    }

    #[test]
    fn write_tools_adds_then_prunes_pi_skills() {
        // spec Scenario「加选与取消 pi 后技能同步」：tools 为 [codex] 时加选 pi 生成
        // .pi/skills/，取消后 specseal- 目录全数移除，.agents/skills/ 的 Codex 技能仍在。
        let fx = FixtureRoot::new("tools-write-pi");
        std::fs::remove_dir_all(fx.root().join("specseal")).unwrap();
        crate::project::init_project_at(fx.root(), &["codex".into()]).expect("init ok");
        let pi_skills = fx.root().join(".pi").join("skills");
        let codex_propose = fx.root().join(".agents").join("skills").join("specseal-propose").join("SKILL.md");
        let codex_before = read(&codex_propose);

        write_tools_at(fx.root(), &["codex".into(), "pi".into()]).expect("add ok");
        let app = read(&fx.root().join(".specseal.yaml"));
        assert!(app.contains("- codex\n- pi"), "tools recorded: {app}");
        assert!(pi_skills.join("specseal-propose").join("SKILL.md").is_file());

        write_tools_at(fx.root(), &["codex".into()]).expect("remove ok");
        let app = read(&fx.root().join(".specseal.yaml"));
        assert!(app.contains("- codex") && !app.contains("- pi"), "tools recorded: {app}");
        assert!(!pi_skills.exists(), ".pi/skills/ 下的 specseal- 目录须全数移除");
        assert_eq!(read(&codex_propose), codex_before, ".agents/skills/ 不得变动");
    }

    #[test]
    fn write_tools_strips_a_legacy_instruction_marker() {
        // spec Scenario「tools 变更后技能同步」的遗留面（design D2）：同步时把旧版
        // 引擎注入的区块剥掉，用户自己的段落原样保留。
        let fx = FixtureRoot::new("tools-write-strip");
        std::fs::remove_dir_all(fx.root().join("specseal")).unwrap();
        crate::project::init_project_at(fx.root(), &["claude".into()]).expect("init ok");
        std::fs::write(
            fx.root().join("CLAUDE.md"),
            "<!-- SPECSEAL:START v1.0.0 -->\n\n旧路由表。\n\n<!-- SPECSEAL:END -->\n我自己的段落\n",
        )
        .unwrap();

        write_tools_at(fx.root(), &["claude".into(), "codex".into()]).expect("write ok");

        let md = read(&fx.root().join("CLAUDE.md"));
        assert!(!md.contains("<!-- SPECSEAL:START"), "遗留区块须被剥除：{md}");
        assert_eq!(md, "我自己的段落\n", "用户段落须原样保留");
    }

    #[test]
    fn write_tools_prunes_deselected_tool_leftovers() {
        let fx = FixtureRoot::new("tools-write-prune");
        std::fs::remove_dir_all(fx.root().join("specseal")).unwrap();
        crate::project::init_project_at(fx.root(), &["claude".into(), "codex".into()])
            .expect("init ok");
        assert!(fx.root().join(".agents").join("skills").is_dir(), "precondition");
        write_tools_at(fx.root(), &["claude".into()]).expect("write ok");
        let app = read(&fx.root().join(".specseal.yaml"));
        assert!(app.contains("claude") && !app.contains("codex"), "tools recorded: {app}");
        // prune：specseal-* 技能目录移除、遗留 marker 区块自 AGENTS.md 剥除。
        let agents_skills = fx.root().join(".agents").join("skills");
        if agents_skills.is_dir() {
            let leftover: Vec<_> = std::fs::read_dir(&agents_skills)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("specseal-"))
                .collect();
            assert!(leftover.is_empty(), "specseal-* skills must be pruned: {leftover:?}");
        }
        if let Ok(agents_md) = std::fs::read_to_string(fx.root().join("AGENTS.md")) {
            assert!(!agents_md.contains("<!-- SPECSEAL:START"), "marker must be stripped");
        }
    }

    #[test]
    fn write_tools_refuses_unparseable_original_and_leaves_file_intact() {
        let fx = FixtureRoot::new("tools-write-bad");
        let bad = "tools: [unclosed\n";
        fx.write(".specseal.yaml", bad);
        let err = write_tools_at(fx.root(), &["claude".into()]).expect_err("must refuse");
        assert!(err.contains(".specseal.yaml"), "must name the file: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert_eq!(read(&fx.root().join(".specseal.yaml")), bad, "file must be untouched");
    }

    #[test]
    fn write_tools_rejects_unknown_tool_name_before_touching_disk() {
        let fx = FixtureRoot::new("tools-write-unknown");
        let doc = "tools:\n  - claude\n";
        fx.write(".specseal.yaml", doc);
        let err = write_tools_at(fx.root(), &["claude".into(), "vscode".into()])
            .expect_err("must reject");
        assert!(err.contains("vscode"), "must name the offender: {err}");
        assert_eq!(read(&fx.root().join(".specseal.yaml")), doc, "file must be untouched");
    }

    // --- context／rules／schemaArtifacts 读取扩充（design D3） ---

    const SPEC_DRIVEN_IDS: [&str; 4] = ["proposal", "design", "specs", "tasks"];
    const NO_SPEC_CHANGE_IDS: [&str; 3] = ["proposal", "design", "tasks"];

    // --- 产出流程快照组装（desktop-schema-panel design D1） ---

    /// 最小合法自订 schema：单一 artifact、模板档在 templates/plan.md。
    const CUSTOM_SCHEMA_YAML: &str = "name: my-flow\nversion: 1\nartifacts:\n  - id: plan\n    generates: plan.md\n    description: 计划文档\n    template: plan.md\n    instruction: 先写计划\n";

    fn discovered(fx: &FixtureRoot) -> Workspace {
        Workspace::discover(fx.root()).expect("discover ok").expect("is a project")
    }

    #[test]
    fn schemas_snapshot_lists_builtin_with_full_artifact_details() {
        // spec Scenario「详情唯读呈现内容」的数据面：内置 spec-driven 与 no-spec-change
        // 依序在前，每个 artifact 带 description／instruction／template 全文。
        let fx = FixtureRoot::new("schemas-builtin");
        let ws = discovered(&fx);
        let snap = schemas_snapshot(Some(&ws), None);
        let builtins: [(&str, &[&str]); 2] =
            [("spec-driven", &SPEC_DRIVEN_IDS), ("no-spec-change", &NO_SPEC_CHANGE_IDS)];
        let names: Vec<&str> = snap.iter().take(2).map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["spec-driven", "no-spec-change"], "内置依序在前");
        for (entry, (name, ids)) in snap.iter().zip(builtins) {
            assert_eq!(entry.name, name);
            assert_eq!(entry.source, "package");
            assert_eq!(entry.artifact_ids, ids, "{name}: artifact 图为引擎显示序");
            assert_eq!(entry.error, None);
            for id in ids {
                let a = entry.artifacts.iter().find(|a| a.id == *id).expect("artifact present");
                assert!(!a.description.is_empty(), "{name}/{id} description 全文");
                assert!(
                    a.instruction.as_deref().is_some_and(|s| !s.is_empty()),
                    "{name}/{id} instruction 全文"
                );
                assert!(
                    a.template.as_deref().is_some_and(|s| !s.is_empty()),
                    "{name}/{id} template 全文"
                );
            }
        }
    }

    #[test]
    fn schemas_snapshot_lists_project_and_user_layers_with_sources() {
        // spec Scenario「清单列出可解析的 schema」＋ Example「清单一列的形状」的
        // 来源层级字段：内置之外，项目层与 user 层各自带正确 source。
        let fx = FixtureRoot::new("schemas-layers");
        let ws = discovered(&fx);
        fx.write("specseal/schemas/my-flow/schema.yaml", CUSTOM_SCHEMA_YAML);
        fx.write("specseal/schemas/my-flow/templates/plan.md", "# 计划模板\n");
        fx.write(
            "userdir/schemas/their-flow/schema.yaml",
            &CUSTOM_SCHEMA_YAML.replace("my-flow", "their-flow"),
        );
        fx.write("userdir/schemas/their-flow/templates/plan.md", "# user 层模板\n");
        let snap = schemas_snapshot(Some(&ws), Some(&fx.root().join("userdir")));
        let names: Vec<(&str, &str)> =
            snap.iter().map(|s| (s.name.as_str(), s.source.as_str())).collect();
        assert_eq!(
            names,
            [
                ("spec-driven", "package"),
                ("no-spec-change", "package"),
                ("my-flow", "project"),
                ("their-flow", "user"),
            ],
            "内置先、项目层次之、user 层最后"
        );
        let custom = &snap[2];
        assert_eq!(custom.artifact_ids, ["plan"]);
        let plan = &custom.artifacts[0];
        assert_eq!(plan.description, "计划文档");
        assert_eq!(plan.instruction.as_deref(), Some("先写计划"));
        assert_eq!(plan.template.as_deref(), Some("# 计划模板\n"));
    }

    #[test]
    fn schemas_snapshot_marks_a_broken_schema_without_dropping_the_list() {
        // design D1：坏 schema 逐项标记错误，不拖垮整份快照。
        let fx = FixtureRoot::new("schemas-broken");
        let ws = discovered(&fx);
        fx.write("specseal/schemas/bad-flow/schema.yaml", "artifacts: [unclosed\n");
        fx.write("specseal/schemas/my-flow/schema.yaml", CUSTOM_SCHEMA_YAML);
        fx.write("specseal/schemas/my-flow/templates/plan.md", "# 计划模板\n");
        let snap = schemas_snapshot(Some(&ws), None);
        let bad = snap.iter().find(|s| s.name == "bad-flow").expect("broken entry listed");
        let msg = bad.error.as_deref().expect("error marked");
        assert!(!msg.is_empty() && !msg.contains('\n'), "single line: {msg:?}");
        assert!(bad.artifacts.is_empty(), "坏项不呈现猜测的内容");
        let good = snap.iter().find(|s| s.name == "my-flow").expect("good entry survives");
        assert_eq!(good.error, None);
        assert_eq!(good.artifact_ids, ["plan"]);
    }

    #[test]
    fn read_schemas_at_walks_the_local_layers_and_rejects_non_projects() {
        // local 入口：discover 项目根、三层解析；非项目为 loud error。
        let fx = FixtureRoot::new("schemas-entry");
        let snap = read_schemas_at(fx.root()).expect("read ok");
        assert_eq!(snap[0].name, "spec-driven");
        assert!(read_schemas_at(&std::env::temp_dir()).is_err());
    }

    #[test]
    fn builtin_schemas_lists_only_the_embedded_builtins() {
        // remote 面数据源（design D3 前置）：只有内嵌内置，不读任何磁盘层。
        let snap = builtin_schemas();
        let rows: Vec<(&str, &str, Vec<String>)> = snap
            .iter()
            .map(|s| (s.name.as_str(), s.source.as_str(), s.artifact_ids.clone()))
            .collect();
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            rows,
            [
                ("spec-driven", "package", ids(&SPEC_DRIVEN_IDS)),
                ("no-spec-change", "package", ids(&NO_SPEC_CHANGE_IDS)),
            ]
        );
    }

    #[test]
    fn schemas_snapshot_carries_the_disk_path_for_file_backed_layers() {
        // spec「产出流程的编辑入口」数据面：项目层与 user 层项目带目录绝对路径
        //（打开所在文件夹的把手），内置无磁盘文件为 None。
        let fx = FixtureRoot::new("schemas-path");
        let ws = discovered(&fx);
        fx.write("specseal/schemas/my-flow/schema.yaml", CUSTOM_SCHEMA_YAML);
        fx.write("specseal/schemas/my-flow/templates/plan.md", "# 计划模板\n");
        fx.write(
            "userdir/schemas/their-flow/schema.yaml",
            &CUSTOM_SCHEMA_YAML.replace("my-flow", "their-flow"),
        );
        fx.write("userdir/schemas/their-flow/templates/plan.md", "# user 层模板\n");
        let user_dir = fx.root().join("userdir");
        let snap = schemas_snapshot(Some(&ws), Some(&user_dir));
        assert_eq!(snap[0].path, None, "内置在 binary 内、无磁盘路径");
        let project = snap.iter().find(|s| s.name == "my-flow").expect("project entry");
        assert_eq!(
            project.path.as_deref(),
            fx.root().join("specseal").join("schemas").join("my-flow").to_str(),
            "项目层带目录绝对路径"
        );
        let user = snap.iter().find(|s| s.name == "their-flow").expect("user entry");
        assert_eq!(
            user.path.as_deref(),
            user_dir.join("schemas").join("their-flow").to_str(),
            "user 层路径由快照组装端解析"
        );
        // camelCase serialize（桥接 payload 惯例）。
        let json = serde_json::to_value(&snap).expect("serialize");
        assert!(json[0].get("path").is_some());
    }

    // --- remote 模式的内置限缩与误解析修正（desktop-schema-panel design D3） ---

    #[test]
    fn remote_snapshot_resolves_builtin_by_the_embedded_definition() {
        // spec Example「remote 解析结果表」row 1／row 2：内置名以内嵌定义解析。
        // row 2 的「本机 user 层同名不参与」由结构保证（remote 入口不收、也不
        // 推导任何 user 层目录）；此处以引擎层对照证明「若参与，结果会不同」。
        let fx = FixtureRoot::new("remote-schema-shadow");
        fx.write(
            "userdir/schemas/spec-driven/schema.yaml",
            &CUSTOM_SCHEMA_YAML.replace("my-flow", "spec-driven"),
        );
        fx.write("userdir/schemas/spec-driven/templates/plan.md", "# shadow\n");
        let user_dir = fx.root().join("userdir");
        let shadowed =
            specseal_core::schema::resolve_with(None, Some(&user_dir), "spec-driven")
                .expect("found")
                .expect("parses");
        assert_eq!(shadowed.artifact_ids(), ["plan"], "user 层定义若参与，artifact 图不同");

        let s = read_workflow_settings_from_text(Some("schema: spec-driven\n"));
        assert_eq!(s.schema_artifacts, SPEC_DRIVEN_IDS, "内嵌定义解析，本机定义不参与");
        assert!(s.schema_known);
    }

    #[test]
    fn remote_snapshot_resolves_no_spec_change_by_the_embedded_definition() {
        // spec Example「remote 解析结果表」no-spec-change 列：以内嵌定义解析，artifact 图为
        // proposal、design、tasks。「本机 user 层同名不参与」同 spec-driven 列由结构保证
        //（remote 入口不收、也不推导任何 user 层目录）；此处以引擎层对照证明「若参与，结果会不同」。
        let fx = FixtureRoot::new("remote-schema-nsc");
        fx.write(
            "userdir/schemas/no-spec-change/schema.yaml",
            &CUSTOM_SCHEMA_YAML.replace("my-flow", "no-spec-change"),
        );
        fx.write("userdir/schemas/no-spec-change/templates/plan.md", "# shadow\n");
        let user_dir = fx.root().join("userdir");
        let shadowed =
            specseal_core::schema::resolve_with(None, Some(&user_dir), "no-spec-change")
                .expect("found")
                .expect("parses");
        assert_eq!(shadowed.artifact_ids(), ["plan"], "user 层定义若参与，artifact 图不同");

        let s = read_workflow_settings_from_text(Some("schema: no-spec-change\n"));
        assert_eq!(s.schema_artifacts, NO_SPEC_CHANGE_IDS, "内嵌定义解析，本机定义不参与");
        assert!(s.schema_known);
    }

    #[test]
    fn remote_snapshot_reports_non_builtin_as_unknown() {
        // spec Example「remote 解析结果表」my-flow 列：非内置不解析——schemaKnown
        // false、产出规则分节不呈现猜测的固定键。
        let s = read_workflow_settings_from_text(Some("schema: my-flow\n"));
        assert_eq!(s.schema_artifacts, Vec::<String>::new());
        assert!(!s.schema_known, "非内置＝远程自订尚不支持");
        assert_eq!(s.parse_error, None, "非内置不是解析错误，是显性状态");
    }

    #[test]
    fn local_snapshot_keeps_three_layer_resolution() {
        // design D3：限缩只作用于 remote 入口——local（workspace Some）三层不变。
        let fx = FixtureRoot::new("local-schema-layers");
        fx.write("specseal/config.yaml", "schema: my-flow\n");
        fx.write("specseal/schemas/my-flow/schema.yaml", CUSTOM_SCHEMA_YAML);
        fx.write("specseal/schemas/my-flow/templates/plan.md", "# 计划模板\n");
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(s.workflow.schema_artifacts, ["plan"], "项目层自订 schema 照常解析");
        assert!(s.workflow.schema_known);
    }

    // --- 切换写入与 fork（desktop-schema-panel design D2 的 local 面） ---

    #[test]
    fn write_workflow_schema_updates_the_key_and_preserves_every_other_byte() {
        // spec Scenario「切换写入且其余内容保留」：仅 schema 键行变动。
        let fx = FixtureRoot::new("schema-write");
        fx.write(
            "specseal/config.yaml",
            "schema: spec-driven\n# 注解保留\nlocale: tw\n",
        );
        write_workflow_schema_at(fx.root(), "my-flow").expect("write ok");
        assert_eq!(
            read(&fx.root().join("specseal/config.yaml")),
            "schema: my-flow\n# 注解保留\nlocale: tw\n"
        );
    }

    #[test]
    fn write_workflow_schema_refuses_a_broken_file_and_leaves_it_intact() {
        // spec Scenario「坏档拒写显性失败」：文件一个字节不变。
        let fx = FixtureRoot::new("schema-write-bad");
        let bad = "rules: [unclosed\n";
        fx.write("specseal/config.yaml", bad);
        let err = write_workflow_schema_at(fx.root(), "my-flow").expect_err("must refuse");
        assert!(!err.is_empty() && !err.contains('\n'), "single line: {err:?}");
        assert_eq!(read(&fx.root().join("specseal/config.yaml")), bad, "file untouched");
    }

    #[test]
    fn fork_schema_copies_into_the_project_layer() {
        // spec Scenario「fork 产出项目层复本」：specseal/schemas/spec-driven-custom/
        // 创建（schema.yaml 与 templates），快照清单反映新项目层项目。
        // 复本名固定为引擎缺省 <source>-custom——UI 不收自订名（review R2：
        // 生产路径恒为缺省，砍掉未被要求的参数）。
        let fx = FixtureRoot::new("schema-fork");
        let name = fork_schema_at(fx.root(), "spec-driven").expect("fork ok");
        assert_eq!(name, "spec-driven-custom");
        let dir = fx.root().join("specseal/schemas/spec-driven-custom");
        assert!(dir.join("schema.yaml").is_file());
        assert!(dir.join("templates").is_dir());
        let snap = read_schemas_at(fx.root()).expect("read ok");
        let forked = snap.iter().find(|s| s.name == "spec-driven-custom").expect("listed");
        assert_eq!(forked.source, "project");
        assert_eq!(forked.artifact_ids, SPEC_DRIVEN_IDS);
    }

    // --- 创建骨架（desktop-schema-panel design D5；spec「产出流程的创建」） ---

    #[test]
    fn init_schema_creates_the_default_skeleton_and_the_snapshot_reflects_it() {
        // spec Example「创建输入与结果」row 1：my-flow → 骨架创建、清单添加项目层项目。
        let fx = FixtureRoot::new("schema-init");
        init_schema_at(fx.root(), "my-flow").expect("init ok");
        let dir = fx.root().join("specseal/schemas/my-flow");
        assert!(dir.join("schema.yaml").is_file());
        assert!(dir.join("templates").is_dir());
        let snap = read_schemas_at(fx.root()).expect("read ok");
        let created = snap.iter().find(|s| s.name == "my-flow").expect("listed");
        assert_eq!(created.source, "project");
        assert_eq!(created.error, None, "引擎骨架必须自我通过解析");
        assert!(!created.artifact_ids.is_empty(), "缺省布局带 artifact 图");
    }

    #[test]
    fn init_schema_rejects_an_invalid_name_and_leaves_the_disk_untouched() {
        // spec Example「创建输入与结果」row 2＋Scenario「不合法名称显性失败」。
        let fx = FixtureRoot::new("schema-init-badname");
        let err = init_schema_at(fx.root(), "My Flow").expect_err("must refuse");
        assert!(err.contains("kebab-case"), "engine message surfaced: {err}");
        assert!(!fx.root().join("specseal/schemas").exists(), "磁盘不变");
    }

    #[test]
    fn init_schema_surfaces_the_engine_error_when_the_target_exists() {
        // spec Example「创建输入与结果」row 3：同名再建拒绝、既有骨架不变。
        let fx = FixtureRoot::new("schema-init-dup");
        init_schema_at(fx.root(), "my-flow").expect("first init ok");
        let before = read(&fx.root().join("specseal/schemas/my-flow/schema.yaml"));
        let err = init_schema_at(fx.root(), "my-flow").expect_err("must refuse");
        assert!(err.contains("already exists"), "engine message surfaced: {err}");
        assert_eq!(
            read(&fx.root().join("specseal/schemas/my-flow/schema.yaml")),
            before,
            "既有骨架不得被覆写"
        );
    }

    // --- 删除（desktop-schema-panel design D7；spec「产出流程的删除」） ---

    #[test]
    fn delete_schema_removes_a_project_layer_schema_and_the_snapshot_reflects_it() {
        // spec Scenario「删除经确认后移除项目层目录」的 core 面。
        let fx = FixtureRoot::new("schema-delete");
        fx.write("specseal/config.yaml", "schema: spec-driven\n");
        fx.write("specseal/schemas/my-flow/schema.yaml", CUSTOM_SCHEMA_YAML);
        fx.write("specseal/schemas/my-flow/templates/plan.md", "# 计划模板\n");
        delete_schema_at(fx.root(), "my-flow").expect("delete ok");
        assert!(!fx.root().join("specseal/schemas/my-flow").exists(), "整个目录移除");
        let snap = read_schemas_at(fx.root()).expect("read ok");
        assert!(snap.iter().all(|s| s.name != "my-flow"), "清单不再列出");
    }

    #[test]
    fn delete_schema_refuses_the_active_schema_and_leaves_it_intact() {
        // spec Scenario「使用中的 schema 拒删」：错误浮出、目录原封不动。
        let fx = FixtureRoot::new("schema-delete-active");
        fx.write("specseal/config.yaml", "schema: my-flow\n");
        fx.write("specseal/schemas/my-flow/schema.yaml", CUSTOM_SCHEMA_YAML);
        fx.write("specseal/schemas/my-flow/templates/plan.md", "# 计划模板\n");
        let err = delete_schema_at(fx.root(), "my-flow").expect_err("must refuse");
        assert!(!err.is_empty() && !err.contains('\n'), "single line: {err:?}");
        assert!(fx.root().join("specseal/schemas/my-flow/schema.yaml").is_file(), "目录不变");
    }

    #[test]
    fn delete_schema_refuses_a_missing_directory() {
        let fx = FixtureRoot::new("schema-delete-missing");
        fx.write("specseal/config.yaml", "schema: spec-driven\n");
        assert!(delete_schema_at(fx.root(), "no-such-flow").is_err());
    }

    #[test]
    fn fork_schema_surfaces_the_engine_error_when_the_target_exists() {
        // 契约失败形：fork 目标已存在时浮出引擎的既有错误消息。
        let fx = FixtureRoot::new("schema-fork-dup");
        fork_schema_at(fx.root(), "spec-driven").expect("first fork ok");
        let err = fork_schema_at(fx.root(), "spec-driven").expect_err("must refuse");
        assert!(err.contains("already exists"), "engine message surfaced: {err}");
    }

    #[test]
    fn delete_schema_rejects_an_invalid_name_before_touching_the_disk() {
        // review S7：name 不经 kebab-case 验证时 `..` 可让 remove_dir_all 逃出
        // 项目目录——与 init／fork 同一道名称门。
        let fx = FixtureRoot::new("schema-delete-badname");
        fx.write("specseal/config.yaml", "schema: spec-driven\n");
        fx.write("outside/schema.yaml", "decoy\n");
        let err = delete_schema_at(fx.root(), "../../outside").expect_err("must refuse");
        assert!(err.contains("kebab-case"), "name gate surfaced: {err}");
        assert!(fx.root().join("outside/schema.yaml").is_file(), "项目外目录不得被触碰");
    }

    #[test]
    fn schema_entry_serializes_camel_case() {
        // 桥接 payload 一律 camelCase（沿 SettingsSnapshot 惯例）。
        let snap = builtin_schemas();
        let json = serde_json::to_value(&snap).expect("serialize");
        assert!(json[0].get("artifactIds").is_some(), "camelCase key");
        assert!(json[0]["artifacts"][0].get("description").is_some());
    }

    fn sections(pairs: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect()))
            .collect()
    }

    #[test]
    fn read_settings_includes_context_rules_and_schema_artifacts() {
        let fx = FixtureRoot::new("settings-content");
        fx.write(
            "specseal/config.yaml",
            "schema: spec-driven\ncontext: |\n  第一行\n  第二行\nrules:\n  tasks:\n    - 先写失败测试\n    - 更新文档\n  proposal:\n    - 提案必须列出影响的 crates\n",
        );
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(s.workflow.context.as_deref(), Some("第一行\n第二行\n"));
        assert_eq!(
            s.workflow.rules.get("tasks").map(Vec::as_slice),
            Some(["先写失败测试".to_string(), "更新文档".to_string()].as_slice()),
            "entry order preserved"
        );
        assert_eq!(
            s.workflow.rules.get("proposal").map(Vec::as_slice),
            Some(["提案必须列出影响的 crates".to_string()].as_slice())
        );
        assert_eq!(s.workflow.schema_artifacts, SPEC_DRIVEN_IDS);
        // 桥接 payload 一律 camelCase。
        let json = serde_json::to_value(&s).expect("serialize");
        assert!(json["workflow"].get("schemaArtifacts").is_some(), "camelCase key");
        assert!(json["workflow"].get("context").is_some());
        assert!(json["workflow"].get("rules").is_some());
    }

    #[test]
    fn read_settings_absent_workflow_reports_unset_content_with_default_schema_artifacts() {
        // 文件缺席＝未设置状态；活跃 schema 为缺省 spec-driven，固定键分节仍可呈现。
        let fx = FixtureRoot::new("settings-content-absent");
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(s.workflow.context, None);
        assert!(s.workflow.rules.is_empty());
        assert_eq!(s.workflow.schema_artifacts, SPEC_DRIVEN_IDS);
    }

    #[test]
    fn read_settings_parse_error_empties_content_fields() {
        // 解析失败浮出 parseError；内容字段不得以猜测值呈现（表单将整份停用）。
        let fx = FixtureRoot::new("settings-content-bad");
        fx.write("specseal/config.yaml", "rules: [unclosed\n");
        let s = read_settings_at(fx.root()).expect("read ok");
        assert!(s.workflow.parse_error.is_some());
        assert_eq!(s.workflow.context, None);
        assert!(s.workflow.rules.is_empty());
        assert!(s.workflow.schema_artifacts.is_empty(), "no schema known for a broken file");
    }

    // --- context／rules 写入（design D4 双重验证沿用） ---

    #[test]
    fn write_workflow_content_sets_context_and_rules_and_keeps_policy() {
        // spec Scenario「编辑项目说明并保存」＋政策字段不受内容写入波及。
        let fx = FixtureRoot::new("wf-content-write");
        let doc = "schema: spec-driven\nlocale: tw\ntdd: true\nrules:\n  proposal:\n    - 旧规则\n";
        fx.write("specseal/config.yaml", doc);
        let rules = sections(&[("proposal", &["旧规则"]), ("tasks", &["@完成后运行全部测试"])]);
        write_workflow_content_at(
            fx.root(),
            &ContentEdit { context: ContextEdit::Set("新的项目说明\n跨两行\n".into()), rules: Some(&rules), ..Default::default() },
        )
        .expect("write ok");
        let text = read(&fx.root().join("specseal/config.yaml"));
        let new: WorkflowConfig = serde_yaml::from_str(&text).expect("output parses");
        assert_eq!(new.context.as_deref(), Some("新的项目说明\n跨两行\n"));
        assert_eq!(
            new.rules.get("tasks").map(Vec::as_slice),
            Some(["@完成后运行全部测试".to_string()].as_slice()),
            "reserved-char entry round-trips"
        );
        assert_eq!(new.locale.as_deref(), Some("tw"), "policy keys untouched");
        assert_eq!(new.tdd, Some(true));
        assert_eq!(new.schema.as_deref(), Some("spec-driven"));
    }

    #[test]
    fn write_workflow_content_clearing_removes_keys() {
        // spec Scenario「清空即移除键」。
        let fx = FixtureRoot::new("wf-content-clear");
        fx.write(
            "specseal/config.yaml",
            "schema: spec-driven\ncontext: 旧说明\nrules:\n  tasks:\n    - t1\n",
        );
        write_workflow_content_at(fx.root(), &ContentEdit { context: ContextEdit::Set("   ".into()), rules: Some(&sections(&[("tasks", &[])])), ..Default::default() })
            .expect("write ok");
        let text = read(&fx.root().join("specseal/config.yaml"));
        let m: serde_yaml::Mapping = serde_yaml::from_str(&text).expect("mapping");
        assert!(!m.contains_key("context"), "blank context removes the key: {text}");
        assert!(!m.contains_key("rules"), "all-empty rules removes the key: {text}");
        assert!(m.contains_key("schema"));
    }

    #[test]
    fn write_workflow_content_refuses_unparseable_original_and_leaves_file_intact() {
        let fx = FixtureRoot::new("wf-content-bad");
        let bad = "rules: [unclosed\n";
        fx.write("specseal/config.yaml", bad);
        let err = write_workflow_content_at(fx.root(), &ContentEdit { context: ContextEdit::Set("x".into()), ..Default::default() })
            .expect_err("must refuse");
        assert!(err.contains("config.yaml"), "must name the file: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert_eq!(read(&fx.root().join("specseal/config.yaml")), bad, "file must be untouched");
    }

    #[test]
    fn write_workflow_content_surfaces_write_failure_with_file_and_stage() {
        let fx = FixtureRoot::new("wf-content-ro");
        let doc = "context: old\n";
        fx.write("specseal/config.yaml", doc);
        let path = fx.root().join("specseal/config.yaml");
        block_writes(&path, true);
        let err = write_workflow_content_at(fx.root(), &ContentEdit { context: ContextEdit::Set("new".into()), ..Default::default() })
            .expect_err("must fail");
        block_writes(&path, false);
        assert!(err.contains("config.yaml"), "must name the file: {err}");
        assert!(err.contains("write"), "must name the stage: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert_eq!(read(&path), doc, "file must be untouched");
    }
    // --- 审查规则（review-rules-config）：快照带出 review 与 12 条名称、只写 review ---

    use specseal_core::config::{ReviewBaseline, ReviewConfig};

    fn review_of(baseline: ReviewBaseline, lists: [&[&str]; 3]) -> ReviewConfig {
        let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
        ReviewConfig {
            baseline,
            critical: list(lists[0]),
            warning: list(lists[1]),
            suggestion: list(lists[2]),
        }
    }

    #[test]
    fn read_settings_carries_review_and_the_engine_smell_names() {
        let fx = FixtureRoot::new("settings-review");
        fx.write("specseal/config.yaml", "review:\n  baseline: replace\n  critical:\n    - 不得写死密钥\n");
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(s.workflow.review, review_of(ReviewBaseline::Replace, [&["不得写死密钥"], &[], &[]]));
        assert_eq!(s.workflow.review_baseline_smells, specseal_core::skills::REVIEW_BASELINE_SMELLS);
        let json = serde_json::to_value(&s.workflow).expect("serializes");
        assert_eq!(
            json["review"],
            serde_json::json!({"baseline": "replace", "critical": ["不得写死密钥"], "warning": [], "suggestion": []})
        );
        let names = json["reviewBaselineSmells"].as_array().expect("camelCase array");
        assert_eq!(names.len(), 12);
        assert_eq!(names[0], "Mysterious Name");
        // 未写 review（含远程的 from-text 入口）＝默认值，12 条照样带出。
        let w = read_workflow_settings_from_text(Some("schema: spec-driven\n"));
        assert_eq!(w.review, ReviewConfig::default());
        assert_eq!(w.review_baseline_smells.len(), 12);
    }

    #[test]
    fn read_settings_review_typo_surfaces_a_parse_error_naming_the_key() {
        // spec Scenario「解析失败时停用编辑」：解析说明含 critcal。
        let fx = FixtureRoot::new("settings-review-typo");
        fx.write("specseal/config.yaml", "review:\n  critcal:\n    - x\n");
        let s = read_settings_at(fx.root()).expect("read ok");
        let msg = s.workflow.parse_error.expect("parse error surfaced");
        assert!(msg.contains("critcal") && !msg.contains('\n'), "single line naming the key: {msg:?}");
        assert_eq!(s.workflow.review, ReviewConfig::default(), "no guessed values on a broken file");
    }

    #[test]
    fn write_workflow_content_writes_only_review_and_keeps_every_other_key() {
        // spec Scenario「编辑并保存仅写 review」：context、rules 与政策字段逐字符不变。
        let fx = FixtureRoot::new("wf-review-write");
        let prefix = "schema: spec-driven\nlocale: tw\ntdd: true\ncontext: |\n  说明\nrules:\n  tasks:\n    - t1\n";
        fx.write("specseal/config.yaml", &format!("{prefix}review:\n  warning:\n    - 旧规则\n"));
        let want = review_of(ReviewBaseline::Extend, [&[], &["旧规则", "添加的公开 API 要有对应的测试"], &[]]);
        write_workflow_content_at(fx.root(), &ContentEdit { review: Some(&want), ..Default::default() }).expect("write ok");
        let text = read(&fx.root().join("specseal/config.yaml"));
        assert!(text.starts_with(prefix), "everything outside review is byte-identical: {text}");
        let cfg = WorkflowConfig::from_text(Some(&text)).expect("output parses");
        assert_eq!(cfg.review(), want);
    }

    #[test]
    fn write_workflow_content_review_removal_matches_the_spec_example_table() {
        // spec Example「移除语意」——逐列对应。
        let rows: [(&str, ReviewConfig, Option<&str>); 3] = [
            (
                "review:\n  critical:\n    - c\n  warning:\n    - w\n",
                review_of(ReviewBaseline::Extend, [&["c"], &[], &[]]),
                Some("review:\n  critical:\n  - c\n"),
            ),
            (
                "review:\n  baseline: replace\n  critical:\n    - c\n",
                review_of(ReviewBaseline::Extend, [&["c"], &[], &[]]),
                Some("review:\n  critical:\n  - c\n"),
            ),
            ("review:\n  suggestion:\n    - s\n", ReviewConfig::default(), None),
        ];
        for (i, (before, want, block)) in rows.into_iter().enumerate() {
            let fx = FixtureRoot::new(&format!("wf-review-remove-{i}"));
            fx.write("specseal/config.yaml", &format!("schema: spec-driven\n{before}"));
            write_workflow_content_at(fx.root(), &ContentEdit { review: Some(&want), ..Default::default() }).expect("write ok");
            let text = read(&fx.root().join("specseal/config.yaml"));
            match block {
                Some(block) => assert_eq!(text, format!("schema: spec-driven\n{block}"), "row {i}"),
                None => assert_eq!(text, "schema: spec-driven\n", "row {i}: review key removed"),
            }
        }
    }

    #[test]
    fn content_text_rewrite_with_no_review_edit_leaves_the_review_block() {
        let original = "schema: spec-driven\ncontext: old\nreview:\n  baseline: replace # kept\n";
        let output = rewrite_workflow_content_text(original, &ContentEdit { context: ContextEdit::Set("new".into()), ..Default::default() })
            .expect("rewrite");
        assert!(output.ends_with("review:\n  baseline: replace # kept\n"), "{output}");
    }

    // --- 子代理模型（desktop-subagent-model-page）：快照带出 subagent_model 与内置清单、只写 subagent_model ---

    use specseal_core::config::ToolName;

    fn subagent_of(
        review: &[(&str, &str)],
        verify: &[(&str, &str)],
        choices: &[(&str, &[&str])],
    ) -> SubagentModelConfig {
        let cells = |pairs: &[(&str, &str)]| {
            pairs.iter().map(|(tool, model)| (ToolName::parse(tool).unwrap(), model.to_string())).collect()
        };
        SubagentModelConfig {
            review: cells(review),
            verify: cells(verify),
            choices: choices
                .iter()
                .map(|(tool, names)| (ToolName::parse(tool).unwrap(), names.iter().map(|n| n.to_string()).collect()))
                .collect(),
        }
    }

    #[test]
    fn read_settings_carries_subagent_model_and_the_engine_builtin_lists() {
        // spec Scenario「唯读呈现」的 config；JSON 形状见设计「快照带出子代理模型与内置清单」。
        let fx = FixtureRoot::new("settings-subagent");
        fx.write(
            "specseal/config.yaml",
            "subagent_model:\n  review:\n    claude: opus\n    codex: gpt-6.1-sol\n  verify:\n    claude: sonnet\n  choices:\n    codex: [gpt-6.1-sol, gpt-6-astra]\n",
        );
        let s = read_settings_at(fx.root()).expect("read ok");
        assert_eq!(
            s.workflow.subagent_model,
            subagent_of(
                &[("claude", "opus"), ("codex", "gpt-6.1-sol")],
                &[("claude", "sonnet")],
                &[("codex", &["gpt-6.1-sol", "gpt-6-astra"])],
            )
        );
        let json = serde_json::to_value(&s.workflow).expect("serializes");
        assert_eq!(
            json["subagentModel"],
            serde_json::json!({
                "review": {"claude": "opus", "codex": "gpt-6.1-sol"},
                "verify": {"claude": "sonnet"},
                "choices": {"codex": ["gpt-6.1-sol", "gpt-6-astra"]},
            })
        );
        assert_eq!(
            json["builtinSubagentModels"],
            serde_json::json!({"claude": ["sonnet", "opus", "haiku", "fable"]})
        );
        // 缺席（含远程的 from-text 入口）＝三个键恒在、各为空对象，内置清单照样带出。
        let absent = serde_json::to_value(read_workflow_settings_from_text(Some("schema: spec-driven\n")))
            .expect("serializes");
        assert_eq!(absent["subagentModel"], serde_json::json!({"review": {}, "verify": {}, "choices": {}}));
        assert_eq!(absent["builtinSubagentModels"], json["builtinSubagentModels"]);
    }

    #[test]
    fn read_settings_subagent_model_typo_surfaces_a_parse_error_naming_the_key() {
        // spec Scenario「解析失败时停用编辑」：解析说明含 reveiw。
        let fx = FixtureRoot::new("settings-subagent-typo");
        fx.write("specseal/config.yaml", "subagent_model:\n  reveiw:\n    claude: opus\n");
        let s = read_settings_at(fx.root()).expect("read ok");
        let msg = s.workflow.parse_error.expect("parse error surfaced");
        assert!(msg.contains("reveiw") && !msg.contains('\n'), "single line naming the key: {msg:?}");
        assert_eq!(s.workflow.subagent_model, SubagentModelConfig::default(), "no guessed values on a broken file");
        assert_eq!(s.workflow.builtin_subagent_models.len(), 1, "the engine lists do not depend on the file");
    }

    #[test]
    fn write_workflow_content_writes_only_subagent_model_and_keeps_every_other_key() {
        // spec Scenario「编辑并保存仅写 subagent_model」：context、rules、review 与政策字段逐字符不变。
        let fx = FixtureRoot::new("wf-subagent-write");
        let prefix = "schema: spec-driven\nlocale: tw\ntdd: true\ncontext: |\n  说明\nrules:\n  tasks:\n    - t1\nreview:\n  warning:\n    - 旧规则\n";
        fx.write("specseal/config.yaml", &format!("{prefix}subagent_model:\n  verify:\n    claude: sonnet\n"));
        let want = subagent_of(&[], &[("claude", "sonnet"), ("codex", "gpt-6-astra")], &[]);
        write_workflow_content_at(fx.root(), &ContentEdit { subagent_model: Some(&want), ..Default::default() })
            .expect("write ok");
        let text = read(&fx.root().join("specseal/config.yaml"));
        assert!(text.starts_with(prefix), "everything outside subagent_model is byte-identical: {text}");
        let cfg = WorkflowConfig::from_text(Some(&text)).expect("output parses");
        assert_eq!(cfg.subagent_model(), want);
    }

    #[test]
    fn content_text_rewrite_with_no_subagent_edit_leaves_the_block_and_its_comments() {
        let original = "schema: spec-driven\ncontext: old\nsubagent_model:\n  review:\n    claude: opus # kept\n";
        let output = rewrite_workflow_content_text(
            original,
            &ContentEdit { context: ContextEdit::Set("new".into()), subagent_model: None, ..Default::default() },
        )
        .expect("rewrite");
        assert!(output.ends_with("subagent_model:\n  review:\n    claude: opus # kept\n"), "{output}");
    }

    #[test]
    fn subagent_model_payload_from_the_frontend_takes_the_strict_parse() {
        // Tauri 壳的 subagentModel 参数走同一个反串行化：非 kebab-case 的工具名称、拼错的子键与
        // 非字符串的值在进入 desktop core 之前就被拒收（audit：类型混淆、注入路径）。
        let parse = |value: serde_json::Value| serde_json::from_value::<SubagentModelConfig>(value);
        let ok = parse(serde_json::json!({"review": {"claude": "opus"}, "verify": {}, "choices": {"my-agent": ["a"]}}))
            .expect("a valid payload parses");
        assert_eq!(ok, subagent_of(&[("claude", "opus")], &[], &[("my-agent", &["a"])]));
        for bad in [
            serde_json::json!({"review": {"Claude Code": "opus"}}),
            serde_json::json!({"review": {"../x": "opus"}}),
            serde_json::json!({"reveiw": {}}),
            serde_json::json!({"review": {"claude": 1}}),
            serde_json::json!({"choices": {"codex": "gpt-6.1-sol"}}),
        ] {
            assert!(parse(bad.clone()).is_err(), "must be refused: {bad}");
        }
    }

    #[test]
    fn content_text_rewrite_with_a_subagent_edit_writes_the_cleaned_block() {
        // 远程与本机共用的纯文本改写：模型值去空白、空值丢弃，清单去空白与空条目、空清单丢弃。
        let original = "schema: spec-driven\nsubagent_model:\n  review:\n    claude: opus # gone\n";
        let edit = subagent_of(
            &[("claude", " haiku "), ("codex", "  ")],
            &[("copilot", "gpt-5.6")],
            &[("codex", &[" gpt-6.1-sol ", "", "  "]), ("cursor", &["  "])],
        );
        let output = rewrite_workflow_content_text(original, &ContentEdit { subagent_model: Some(&edit), ..Default::default() })
            .expect("rewrite");
        let cfg = WorkflowConfig::from_text(Some(&output)).expect("output parses");
        assert_eq!(
            cfg.subagent_model(),
            subagent_of(&[("claude", "haiku")], &[("copilot", "gpt-5.6")], &[("codex", &["gpt-6.1-sol"])])
        );
        assert!(!output.contains("# gone"), "the whole block is replaced: {output}");
    }
}
