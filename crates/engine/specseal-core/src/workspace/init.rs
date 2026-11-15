//! Project initialization and instruction-file updates.

use crate::config::{CustomTool, ToolEntry};
use crate::skills::{self, SpecLocation, Tool};
use crate::util;
use crate::workspace::{resolve_spec_dir, DEFAULT_SPEC_DIR, LEGACY_SPEC_DIR};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// 产物层的唯一版号：技能档 frontmatter 的 version 同源于此，也是过期探测与
/// 降级守门的比对基准。仅在内嵌资产（assets/skills）的 render 内容变动时递增——
/// 与 app／CLI 的发版号无关；`assets.lock` 锁定测试把这条纪律变成红灯。
pub const ASSET_VERSION: &str = "v1.58.4";

const APP_CONFIG_TEMPLATE: &str = concat!(
    "# Specseal application config
# See: ",
    env!("CARGO_PKG_REPOSITORY"),
    "

# Spec directory (relative to project root; default: specseal)
# spec_dir: docs/specs

# AI tools to generate instruction files for
# tools:
#   - claude
#   - codex
",
);

const WORKFLOW_CONFIG_TEMPLATE: &str = "schema: spec-driven

# Workflow policy (optional)
# Personal/CI overrides: SPECSEAL_LOCALE, SPECSEAL_SPEC_LOCALE, SPECSEAL_TDD, SPECSEAL_AUDIT, SPECSEAL_WORKTREE
#
# Language for AI-generated artifacts (default: English)
# locale: tw
#
# Language for spec files (default: English; \"auto\" follows locale)
# spec_locale: auto
#
# Workflow toggles (default: off)
# tdd: true
# audit: true
# worktree: true

# Project context (optional)
# This is shown to AI when creating artifacts.
# Add your tech stack, conventions, style guides, domain knowledge, etc.
# Example:
#   context: |
#     Tech stack: TypeScript, React, Node.js
#     We use conventional commits
#     Domain: e-commerce platform

# Per-artifact rules (optional)
# Add custom rules for specific artifacts.
# Example:
#   rules:
#     proposal:
#       - Keep proposals under 500 words
#       - Always include a \"Non-goals\" section
#     tasks:
#       - Break tasks into chunks of max 2 hours
";

const GITIGNORE_BLOCK: &str = "# Specseal app data\n.specseal/\n";

pub struct InitOutcome {
    pub spec_dir_abs: PathBuf,
    /// Set when `init` imported an OpenSpec project (spec-dir-migration D5).
    pub imported: Option<crate::migrate::MigrationReport>,
}

/// Initialize specseal in `root`: the spec-document tree (spec directory skeleton and
/// workflow-config template), then the host-side files — `.specseal.yaml`, the
/// `.gitignore` entry and the selected tools' skills. Instruction files (`CLAUDE.md`,
/// `AGENTS.md`) are NOT part of the managed set (change: remove-marker-injection);
/// routing lives in the skills themselves.
///
/// The skills go through [`SyncPlan::apply`], the same writer every other entry uses
/// (change: workspace-sync-entrypoints). So `tools` is the COMPLETE desired state here
/// too, and `force` only decides whether an initialized workspace is accepted at all —
/// every init that reaches `apply` (a `--force` re-init, or a first init over residual
/// skill files with no `.specseal.yaml`) drops the deselected built-ins' skill
/// footprints, removes `specseal-` directories outside the current set, and resets the
/// recorded descriptor footprints — matching the `.specseal.yaml` write, which is the
/// template. Of a tool's own content only `specseal-` prefixed directories are removed;
/// a skills directory (and its parent) that this leaves empty goes too, as does an
/// emptied `.specseal/`.
///
/// A directory with `openspec/` and neither `.specseal.yaml` nor `specseal/` is an OpenSpec
/// project: under the default spec_dir, init imports it first — the same checks and move
/// as `update`'s migration, refusing with zero writes when a check fails — and never lays a
/// template over the files it brought along.
///
/// A `--force` re-init of a legacy project (`.specseal.yaml` and only `openspec/`) under
/// the default spec_dir works on `openspec/` in place and writes no `spec_dir` line, so
/// the project keeps its specs and stays free to migrate.
pub fn init(root: &Path, tools: &[Tool], force: bool, spec_dir: &str) -> Result<InitOutcome> {
    use crate::workspace::SpecLayout;
    let layout = resolve_spec_dir(root, None).1;
    let default = spec_dir == DEFAULT_SPEC_DIR;
    let import = default && layout == SpecLayout::OpenSpec;
    // The folder this init writes into; `spec_dir` stays what `.specseal.yaml` records.
    let folder = if default && layout == SpecLayout::Legacy { LEGACY_SPEC_DIR } else { spec_dir };
    let spec_root = root.join(folder);
    // 不是项目根却已有 specseal：那是规格文件夹以外的东西（例如同名的 repo clone）。
    if !force && folder == DEFAULT_SPEC_DIR && spec_root.symlink_metadata().is_ok() && !crate::workspace::is_project_root(root) {
        bail!("cannot initialize: {DEFAULT_SPEC_DIR} already exists and is not a spec folder — move it away first");
    }
    if !force && (spec_root.exists() || root.join(".specseal.yaml").is_file()) {
        bail!("Already initialized. Use --force to reinitialize.");
    }
    // 守门在任何写入之前：检查面就是这次要写的 skills 目录（导入时由 import_openspec 守）。
    let imported = if import {
        Some(import_openspec(root, tools)?)
    } else {
        SyncPlan::resolve(root, ToolSelection::builtins_only(tools), folder, SpecLocation::InCheckout).guard()?;
        None
    };
    // 导入时既有的 config.yaml 是用户的，`--force` 也不得以范本覆盖。
    store_init(&spec_root, force && !import)?;
    write_if(&root.join(".specseal.yaml"), &app_config_text(tools, spec_dir), force)?;
    ensure_gitignore(&root.join(".gitignore"))?;
    // 第二次解析是刻意的：政策以 store_init 之后的 config.yaml 为准——`--force` 会把
    // 它写回范本，写入用的计划要在那之后才解析才会排除被政策关掉的技能。守门面只取
    // 决于选集，所以两次的目录集合相同。apply 的回报（pruned／stripped）在 init 不
    // 呈现：init 的 stdout 维持既有两行（proposal Non-Goal）。
    SyncPlan::resolve(root, ToolSelection::builtins_only(tools), folder, SpecLocation::InCheckout).apply(root)?;

    Ok(InitOutcome {
        spec_dir_abs: spec_root,
        imported,
    })
}

/// Import an OpenSpec project into `specseal/` — the first step `init` and [`adopt`]
/// share (desktop-spec-dir-migration D3): the same checks `update`'s migration defers on,
/// as a refusal here, then the downgrade guard over the skills `tools` will write, then
/// the move. A refusal leaves the project untouched rather than half-imported.
fn import_openspec(root: &Path, tools: &[Tool]) -> Result<crate::migrate::MigrationReport> {
    let plan = match crate::migrate::plan_import(root) {
        crate::migrate::MigrationPlan::Deferred(reason) => {
            bail!("cannot import {LEGACY_SPEC_DIR}/: {reason}")
        }
        plan => plan,
    };
    SyncPlan::resolve(root, ToolSelection::builtins_only(tools), DEFAULT_SPEC_DIR, SpecLocation::InCheckout).guard()?;
    crate::migrate::apply(root, &plan)
}

/// Remote-store initialization: the same host-side files as [`init`] plus the
/// `remote:` section in `.specseal.yaml` — deliberately NO spec-document tree (it
/// lives on the server, so no spec directory skeleton and no local workflow-config
/// template).
pub fn init_remote(
    root: &Path,
    tools: &[Tool],
    force: bool,
    url: &str,
    repo: Option<&str>,
) -> Result<()> {
    if !force && root.join(".specseal.yaml").is_file() {
        bail!("Already initialized. Use --force to reinitialize.");
    }
    // Remote init 不写规格文件夹，政策档不会被重写，所以一份计划同时服务守门与写入。
    // 规格在 Server 上：remote 区段在这之后才写入，所以「不在 checkout」由这里直接给。
    let plan = SyncPlan::resolve(root, ToolSelection::builtins_only(tools), DEFAULT_SPEC_DIR, SpecLocation::Elsewhere);
    plan.guard()?;

    write_if(&root.join(".specseal.yaml"), &app_config_text(tools, DEFAULT_SPEC_DIR), force)?;
    ensure_gitignore(&root.join(".gitignore"))?;
    // 回报同 `init`：不呈现。
    plan.apply(root)?;
    crate::config::write_remote_section(root, url, repo)
}

/// The initial `.specseal.yaml`: the template plus the actual tool selection (so `update`
/// can sync against the recorded list later). A non-default spec_dir is persisted as an
/// active `spec_dir` line so later commands find it.
fn app_config_text(tools: &[Tool], spec_dir: &str) -> String {
    let mut content = if tools.is_empty() {
        APP_CONFIG_TEMPLATE.to_string()
    } else {
        let names: Vec<&str> = tools.iter().map(|t| t.name()).collect();
        format!("{APP_CONFIG_TEMPLATE}tools: [{}]\n", names.join(", "))
    };
    if spec_dir != DEFAULT_SPEC_DIR {
        content = content.replace("# spec_dir: docs/specs", &format!("spec_dir: {spec_dir}"));
    }
    content
}

/// Store init: the spec-document tree (the spec directory skeleton) and the workflow-config
/// template — the canonical home of the policy fields.
fn store_init(spec_root: &Path, force: bool) -> Result<()> {
    std::fs::create_dir_all(spec_root.join("specs"))?;
    std::fs::create_dir_all(spec_root.join("changes").join("archive"))?;
    write_if(&spec_root.join("config.yaml"), WORKFLOW_CONFIG_TEMPLATE, force)
}

#[derive(Debug)]
pub struct UpdateOutcome {
    pub updated: Vec<String>,
    pub pruned: Vec<String>,
    /// 项目根相对路径：这次同步剥除掉遗留 SPECSEAL 区块的指令档（design D2）。
    pub stripped: Vec<String>,
    /// 弃用提示（design D3）：非错误、不影响 exit code，CLI 走 stderr。
    pub deprecations: Vec<String>,
    pub notes: Vec<String>,
    /// Tools a Server gave no skill at all: their skills directories were neither
    /// written nor cleaned (design D9). Always empty for a sync from the local templates.
    pub unserved: Vec<String>,
    /// What `update` decided about the spec directory layout before syncing
    /// (spec-dir-migration D5); `Nothing` for every other entry.
    pub migration: crate::migrate::MigrationPlan,
    /// What that migration did.
    pub migrated: crate::migrate::MigrationReport,
}

/// The tool selection `.specseal.yaml` records, resolved ONCE: built-in names
/// deduplicated, descriptors validated, and the legacy "no tools list" fallback
/// decided. Every consumer of the tools list reads this — `update`, `probe_assets`,
/// `reconcile_builtin_tools` and the desktop checkout preselection.
///
/// A descriptor problem is carried on the value instead of raised: `update` and
/// `reconcile` turn it into an error before any write (bad descriptor ⇒ zero writes),
/// while `probe_assets` never reads it — an invalid descriptor simply never becomes a
/// target, and the probe's verdict must not change because one entry is broken.
#[derive(Debug)]
pub struct ToolSelection {
    /// Built-in tools in list order, deduplicated.
    pub builtins: Vec<Tool>,
    /// Validated descriptors in list order.
    pub customs: Vec<CustomTool>,
    /// Warnings that are not errors: unknown built-in names.
    pub notes: Vec<String>,
    /// The first invalid or duplicate descriptor, as a single-line message.
    pub descriptor_error: Option<String>,
    /// True when `.specseal.yaml` records no tools list at all — `builtins` then comes
    /// from directory detection, not from the file.
    pub legacy_fallback: bool,
}

impl ToolSelection {
    /// Resolve the selection from a loaded `.specseal.yaml`. Without a tools list the
    /// legacy rule applies: regenerate Claude when `.claude` exists, codex excluded.
    pub fn resolve(root: &Path, app: &crate::config::AppConfig) -> ToolSelection {
        let mut sel = ToolSelection {
            builtins: Vec::new(),
            customs: Vec::new(),
            notes: Vec::new(),
            descriptor_error: None,
            legacy_fallback: app.tools.is_empty(),
        };
        for entry in &app.tools {
            match entry {
                ToolEntry::Builtin(name) => match Tool::parse(name) {
                    Some(t) => {
                        if !sel.builtins.contains(&t) {
                            sel.builtins.push(t);
                        }
                    }
                    None => sel.notes.push(format!(
                        "unknown tool '{name}' in .specseal.yaml tools list (supported: {})",
                        Tool::supported_names()
                    )),
                },
                ToolEntry::Descriptor(d) => {
                    // Keep the FIRST problem (it is the one update reports), but keep
                    // collecting the valid descriptors after it: the probe reads
                    // `customs` and must not lose a tool because an earlier entry is broken.
                    let problem = match d.validate() {
                        Ok(custom) => {
                            if sel.customs.iter().any(|c| c.name == custom.name) {
                                Some(format!("tool descriptor: duplicate name '{}'", custom.name))
                            } else {
                                sel.customs.push(custom);
                                None
                            }
                        }
                        Err(message) => Some(message),
                    };
                    if sel.descriptor_error.is_none() {
                        sel.descriptor_error = problem;
                    }
                }
            }
        }
        if sel.legacy_fallback && root.join(".claude").is_dir() {
            sel.builtins.push(Tool::Claude);
        }
        sel
    }

    /// The names of the selected tools, in the order a sync writes them: the built-ins
    /// (claude, codex, copilot, pi, cursor), then the descriptors in list order. A
    /// Server's answer names its tools by these.
    pub fn labels(&self) -> Vec<String> {
        let builtins = Tool::ALL.into_iter().filter(|tool| self.builtins.contains(tool)).map(|tool| tool.name().to_string());
        builtins.chain(self.customs.iter().map(|custom| custom.name.clone())).collect()
    }

    /// Where each selected tool keeps its skills, project-root relative and `/`-joined,
    /// in the order of [`ToolSelection::labels`].
    pub fn skills_dirs(&self) -> Vec<String> {
        let builtins =
            Tool::ALL.into_iter().filter(|tool| self.builtins.contains(tool)).map(|tool| tool.skills_dir().to_string());
        builtins.chain(self.customs.iter().map(|custom| custom.skills_dir.clone())).collect()
    }

    /// Build a selection straight from an in-memory built-in list — the entry `init`,
    /// `init_remote` and `reconcile_builtin_tools` use, where the selection is the
    /// caller's argument rather than a file.
    pub fn builtins_only(tools: &[Tool]) -> ToolSelection {
        ToolSelection {
            builtins: tools.to_vec(),
            customs: Vec::new(),
            notes: Vec::new(),
            descriptor_error: None,
            legacy_fallback: false,
        }
    }
}

/// Where this project's spec folder is — the render input every sync entry and the
/// staleness probe share (spec workspace-tools「技能依规格是否在 checkout 渲染」). The
/// `remote:` section of `.specseal.yaml` is the only signal, the same one mode resolution
/// reads: a remote project keeps its specs on the Server. A spec folder on disk is not
/// asked — a remote checkout may still hold an old one.
fn spec_location(app: &crate::config::AppConfig) -> SpecLocation {
    if app.remote.is_some() {
        SpecLocation::Elsewhere
    } else {
        SpecLocation::InCheckout
    }
}

/// The managed skill set of ONE render target: `specseal-<name>` directory → SKILL.md
/// content. This is the only producer of that set — generation, orphan cleanup, the
/// staleness diff and the guard all read it through [`SyncPlan`].
///
/// Non-Claude targets skip the `claude_only` skills; worktree-gated skills need the policy on.
/// `location` is the render's project side (see [`spec_location`]).
///
/// Public for the host kit's HTTP door: a Server answers a skills request with this same
/// set, with `worktree_on` read from the scope's workflow config ([`worktree_skills_on`]).
pub fn managed_skills(
    target: skills::RenderTarget,
    worktree_on: bool,
    spec_dir: &str,
    location: SpecLocation,
) -> Vec<(String, String)> {
    let non_claude = !matches!(target, skills::RenderTarget::Builtin(Tool::Claude));
    skills::registry()
        .into_iter()
        .filter(|s| !(non_claude && s.claude_only))
        .filter(|s| !s.worktree_gated || worktree_on)
        .map(|s| {
            let content = skills::render_skill_file_for(target, &s, spec_dir, location);
            (format!("specseal-{}", s.name), content)
        })
        .collect()
}

/// The skills a Server gave for one tool, with their texts: the tool's name as the
/// request sent it, and each skill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedTool {
    pub tool: String,
    pub skills: Vec<RenderedSkill>,
}

/// One skill of a Server's answer: its name (`apply`, without the `specseal-` of its
/// folder) and the text of its SKILL.md.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedSkill {
    pub name: String,
    pub content: String,
}

/// Whether `name` has the form of a skill name in the registry: lower-case letters,
/// digits and single hyphens between them, 64 characters at most. It becomes a folder
/// name, so nothing that could leave the skills directory (a slash, a backslash, `..`,
/// an empty name) is one, nor a name long enough for a file system to refuse the path.
fn is_skill_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.split('-').all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// The name a render target goes by in a sync's reports and in a Server's answer.
fn label_of(target: skills::RenderTarget<'_>) -> &str {
    match target {
        skills::RenderTarget::Builtin(tool) => tool.name(),
        skills::RenderTarget::Custom(custom) => custom.name.as_str(),
    }
}

/// One tool's slice of a sync: where its skills live, and what should be there.
#[derive(Debug)]
pub(crate) struct SyncTarget {
    /// The name that appears in [`UpdateOutcome`]'s lists and the CLI output.
    pub(crate) label: String,
    /// Project-root-relative skills directory, `/`-joined (`.claude/skills`,
    /// a descriptor's `skills_dir`) — the form the probe reports paths in.
    pub(crate) skills_dir: String,
    /// The same directory as an absolute path — what the guard and the writers use.
    pub(crate) skills_root: PathBuf,
    /// `specseal-<name>` directory → SKILL.md content.
    pub(crate) files: Vec<(String, String)>,
}

/// One workspace sync, resolved once and consumed by every station: the downgrade guard,
/// generation, pruning and the staleness probe all read THIS. The guard's target set and
/// the write set are the same `targets` field, so they cannot drift apart.
///
/// Sharp edges (audit, change workspace-sync-plan):
/// - A descriptor whose `skills_dir` escapes the project root never becomes a target —
///   `ToolDescriptor::validate` rejects it before [`ToolSelection`] carries it.
/// - `apply`'s orphan cleanup removes `specseal-` prefixed directories only, so a user's
///   own skill directories under the same root survive.
/// - `guard` has exactly one bypass, `update`'s explicit `--allow-downgrade`; every other
///   regeneration path of the local templates calls it.
/// - Outside this crate a plan can only be built by [`SyncPlan::from_rendered`], from
///   skills a Server gave: skill names are checked there, so a response cannot name a
///   path outside a tool's skills directory.
pub struct SyncPlan {
    /// Ordered claude, codex, copilot, pi, cursor, then descriptors in list order.
    pub(crate) targets: Vec<SyncTarget>,
    /// Built-ins that are NOT selected and lose their footprint. Empty on the legacy
    /// fallback: without a tools list, nothing was ever "deselected".
    pub(crate) deselected_builtins: Vec<Tool>,
    /// Descriptors that still declare the deprecated `instructions_file`: the file to
    /// strip a legacy marker from, and the deprecation notice to report.
    pub(crate) custom_strip_targets: Vec<(String, String)>,
    pub(crate) selection: ToolSelection,
    /// Selected tools a Server gave no skill at all ([`SyncPlan::from_rendered`]). They
    /// are no target: nothing of theirs is written, cleaned or compared.
    pub(crate) unserved: Vec<String>,
    /// The project root the targets hang off — the shared-directory check compares
    /// paths below it.
    pub(crate) root: PathBuf,
}

impl SyncPlan {
    /// Build the plan. This is the ONE place a sync reads the worktree policy.
    /// `location` is the caller's: a project that already has a `.specseal.yaml` takes it
    /// from [`spec_location`]; an init knows which kind of project it is creating.
    pub(crate) fn resolve(
        root: &Path,
        selection: ToolSelection,
        spec_dir: &str,
        location: SpecLocation,
    ) -> SyncPlan {
        let config = util::read_opt(&root.join(spec_dir).join("config.yaml"));
        let worktree_on = worktree_skills_on(config.as_deref());
        let rendered = |target: skills::RenderTarget| -> Result<_, std::convert::Infallible> {
            Ok(managed_skills(target, worktree_on, spec_dir, location))
        };
        let Ok(plan) = SyncPlan::build(root, selection, rendered);
        plan
    }

    /// A plan whose files are the skills a Server gave for this checkout's tools, not
    /// this engine's own render (spec workspace-tools「remote 项目的技能取自 Server」).
    /// `rendered` must hold exactly the selection's tools, each once, by the name the
    /// request sent (a built-in's name, a descriptor's name); a skill name must be a
    /// plain name (`apply`, `worktree-merge`). Anything else is refused here, before any
    /// write, as is an invalid descriptor and a skills directory shared through a symlink.
    ///
    /// The downgrade guard is not asked: a remote project's skills follow its Server,
    /// also back to an older version ([`SyncPlan::leading_version`] says when that happens).
    ///
    /// A tool whose skill list is empty is no target of the plan: [`SyncPlan::apply`]
    /// neither writes nor cleans its skills directory, and names it in
    /// [`UpdateOutcome::unserved`].
    pub fn from_rendered(root: &Path, selection: ToolSelection, rendered: Vec<RenderedTool>) -> Result<SyncPlan> {
        if let Some(message) = &selection.descriptor_error {
            bail!("{message}");
        }
        let answer: Vec<(&str, Vec<&str>)> = rendered
            .iter()
            .map(|tool| (tool.tool.as_str(), tool.skills.iter().map(|skill| skill.name.as_str()).collect()))
            .collect();
        check_answer(&selection.labels(), &answer)?;
        let mut by_tool: std::collections::HashMap<String, Vec<RenderedSkill>> =
            rendered.into_iter().map(|tool| (tool.tool, tool.skills)).collect();
        let files_of = |target: skills::RenderTarget| -> Result<_, std::convert::Infallible> {
            let skills = by_tool.remove(label_of(target)).unwrap_or_default();
            Ok(skills.into_iter().map(|skill| (format!("specseal-{}", skill.name), skill.content)).collect())
        };
        let Ok(mut plan) = SyncPlan::build(root, selection, files_of);
        // Checked on every selected tool, before the ones without skills leave the plan:
        // a tool that is left alone can still share its directory with one that is
        // cleaned, and the cleaning would then remove what was to stay.
        plan.refuse_shared_skill_dirs()?;
        // A tool the Server gives no skill is left alone (design D9): an empty set is
        // more often a filter that came out empty than a wish to remove every skill,
        // and removing is the direction that cannot be taken back.
        let (served, unserved): (Vec<SyncTarget>, Vec<SyncTarget>) =
            plan.targets.into_iter().partition(|target| !target.files.is_empty());
        plan.targets = served;
        plan.unserved = unserved.into_iter().map(|target| target.label).collect();
        Ok(plan)
    }

    /// The version of the skills in this plan's directories that is numerically newer
    /// than `version`, if any: what applying a plan of `version` would take the checkout
    /// back from.
    pub fn leading_version(&self, version: &str) -> Option<String> {
        self.targets.iter().find_map(|target| leading_skill_version(&target.skills_root, version))
    }

    /// The plan of `selection`, with each target's files from `files_of`.
    fn build<E>(
        root: &Path,
        selection: ToolSelection,
        mut files_of: impl FnMut(skills::RenderTarget) -> Result<Vec<(String, String)>, E>,
    ) -> Result<SyncPlan, E> {
        let mut targets = Vec::new();
        for tool in Tool::ALL {
            if selection.builtins.contains(&tool) {
                targets.push(SyncTarget {
                    label: tool.name().to_string(),
                    skills_dir: tool.skills_dir().to_string(),
                    skills_root: root.join(tool.skills_dir()),
                    files: files_of(skills::RenderTarget::Builtin(tool))?,
                });
            }
        }
        let mut custom_strip_targets = Vec::new();
        for custom in &selection.customs {
            // `skills_dir` 已在 `ToolDescriptor::validate` 范式（削结尾分隔符、
            // 拒绝削完等于项目根或撞上内置目录者），这里直接信任字段。
            targets.push(SyncTarget {
                label: custom.name.clone(),
                skills_dir: custom.skills_dir.clone(),
                skills_root: root.join(&custom.skills_dir),
                files: files_of(skills::RenderTarget::Custom(custom))?,
            });
            if let Some(file) = custom.instructions_file.as_deref() {
                custom_strip_targets.push((
                    file.to_string(),
                    format!(
                        "tool descriptor '{}': instructions_file is deprecated and no longer generates anything — remove it from .specseal.yaml",
                        custom.name
                    ),
                ));
            }
        }
        let deselected_builtins = if selection.legacy_fallback {
            Vec::new()
        } else {
            Tool::ALL
                .into_iter()
                .filter(|t| !selection.builtins.contains(t))
                .collect()
        };
        Ok(SyncPlan {
            targets,
            deselected_builtins,
            custom_strip_targets,
            selection,
            unserved: Vec::new(),
            root: root.to_path_buf(),
        })
    }

    /// The pre-write guard: the shared-directory check, then the downgrade guard (refuse
    /// when any target's skills directory leads this engine). The checked set IS the write
    /// set.
    pub(crate) fn guard(&self) -> Result<()> {
        self.refuse_shared_skill_dirs()?;
        let dirs: Vec<PathBuf> = self.targets.iter().map(|t| t.skills_root.clone()).collect();
        refuse_downgrade(&dirs)
    }

    /// Refuse a sync whose skills directories are shared through a symlink (decision 「同步
    /// 前拒绝经 symlink 共用的 skills 目录」): a selected target that resolves to the same
    /// directory as another selected target, or as a deselected built-in this sync would
    /// prune, would have one tool's write overwrite or delete the other's. A link that
    /// resolves anywhere else (a shared folder outside the project) is fine.
    /// `--allow-downgrade` skips the downgrade guard, never this check.
    pub(crate) fn refuse_shared_skill_dirs(&self) -> Result<()> {
        let entry = |rel: &str, label: &str| SharedDirEntry {
            resolved: resolved_dir(&self.root.join(rel)),
            linked: passes_through_symlink(&self.root, rel),
            rel: rel.to_string(),
            label: label.to_string(),
        };
        let written: Vec<SharedDirEntry> =
            self.targets.iter().map(|t| entry(&t.skills_dir, &t.label)).collect();
        // A deselected built-in behind a link is never pruned (prune_tool), so it cannot
        // take a selected tool's files with it.
        let pruned: Vec<SharedDirEntry> = self
            .deselected_builtins
            .iter()
            .map(|t| entry(t.skills_dir(), t.name()))
            .filter(|e| !e.linked)
            .collect();
        for (i, a) in written.iter().enumerate() {
            let Some(b) = written[i + 1..].iter().chain(&pruned).find(|b| b.resolved == a.resolved) else {
                continue;
            };
            // Name the linked directory first: that is the one the user set up.
            let (a, b) = if b.linked && !a.linked { (b, a) } else { (a, b) };
            bail!(
                "skills directory {} ({}) resolves to the same directory as {} ({}) — remove the symlink or deselect one of them",
                a.rel, a.label, b.rel, b.label
            );
        }
        Ok(())
    }

    /// Every target's managed files that are absent or differ from the current render
    /// (line endings normalized), as project-root-relative `/`-joined paths. Descriptors
    /// are included: their skill files are managed exactly like a built-in's, so the
    /// staleness probe must see them too.
    pub(crate) fn differing_files(&self) -> Vec<String> {
        let mut differing = Vec::new();
        for target in &self.targets {
            for (dir, expected) in &target.files {
                let actual =
                    std::fs::read_to_string(target.skills_root.join(dir).join("SKILL.md"))
                        .unwrap_or_default();
                if eol_normalized(&actual) != eol_normalized(expected) {
                    differing.push(format!("{}/{dir}/SKILL.md", target.skills_dir));
                }
            }
        }
        differing
    }

    /// The ONE writer behind every regeneration entry — [`init`], [`init_remote`],
    /// [`adopt`], [`reconcile_builtin_tools`] and [`update`]; each entry adds only its
    /// own precondition on top. Order (any step's `Err` stops the run; what is written
    /// stays — every step is idempotent, so a rerun converges):
    ///
    /// 1. Strip legacy `SPECSEAL:START..END` blocks from the two built-in instruction
    ///    files and from every descriptor that still declares `instructions_file`.
    /// 2. Delete the footprints of descriptors that fell off the list. This happens
    ///    BEFORE generation on purpose: a descriptor that only changed its NAME keeps
    ///    the same `skills_dir`, and deleting after writing would take the fresh files
    ///    with it. Reporting stays late so `pruned` keeps its built-ins-first order.
    /// 3. Per target (claude, codex, copilot, pi, cursor, then descriptors): write every
    ///    managed file and remove the `specseal-` directories that are not in the set.
    /// 4. Prune the deselected built-ins.
    /// 5. Record the current descriptors as the footprint for the next sync.
    pub fn apply(&self, root: &Path) -> Result<UpdateOutcome> {
        let mut out = UpdateOutcome {
            updated: Vec::new(),
            pruned: Vec::new(),
            stripped: Vec::new(),
            deprecations: Vec::new(),
            notes: self.selection.notes.clone(),
            unserved: self.unserved.clone(),
            migration: crate::migrate::MigrationPlan::Nothing,
            migrated: crate::migrate::MigrationReport::default(),
        };

        // 1. 遗留剥除——内置工具唯一的剥除点（prune_tool 只清技能足迹）。
        for rel in Tool::ALL.into_iter().filter_map(instructions_path) {
            if strip_legacy_marker(&root.join(rel))? {
                out.stripped.push(rel.to_string());
            }
        }
        for (file, deprecation) in &self.custom_strip_targets {
            out.deprecations.push(deprecation.clone());
            if strip_legacy_marker(&root.join(file))? {
                out.stripped.push(file.clone());
            }
        }

        // 2. 旧足迹。判定只看 name 与 skills_dir：instructions_file 已弃用，照提示把它
        //    移除不得被误判「已下架」。
        // 足迹比对读的是 `validate` 范式后的 skills_dir。旧版引擎记下的可能是未削
        // 的拼法（`.cursor/skills/`），升级后第一次同步会判它已下架、先剪再重写同一
        // 个目录，并在 `pruned` 报一次该工具——一次性的误报，之后两边同形就消失。
        let mut pruned_customs = Vec::new();
        for old in load_custom_state(root) {
            let still_current = self
                .selection
                .customs
                .iter()
                .any(|c| c.name == old.name && c.skills_dir == old.skills_dir);
            if !still_current && prune_custom(root, &old, &mut out.notes)? {
                pruned_customs.push(old.name.clone());
            }
        }

        for target in &self.targets {
            for (dir, content) in &target.files {
                util::write_file(&target.skills_root.join(dir).join("SKILL.md"), content)?;
            }
            let expected: Vec<String> = target.files.iter().map(|(dir, _)| dir.clone()).collect();
            prune_orphan_skills(&target.skills_root, &expected)?;
            out.updated.push(target.label.clone());
        }

        for tool in &self.deselected_builtins {
            if prune_tool(root, *tool)? {
                out.pruned.push(tool.name().to_string());
            }
        }

        out.pruned.extend(pruned_customs);
        save_custom_state(root, &self.selection.customs)?;

        Ok(out)
    }
}

/// Refresh generated skill files and strip legacy instruction-file markers.
///
/// When `.specseal.yaml` records a `tools:` list, this is a full sync: every listed tool
/// (built-in name or custom descriptor) has its skills regenerated and generated files for
/// tools NOT on the list are pruned (specseal-* skill dirs removed). Unknown built-in names
/// produce a warning note; an invalid descriptor is an error. Without a recorded list,
/// built-ins fall back to legacy behavior: regenerate the tools whose dot-directories exist
/// (codex excluded).
///
/// Legacy stripping (change remove-marker-injection, design D2): instruction files are no
/// longer part of the managed set, so every sync strips the `SPECSEAL:START..END` block an
/// older engine injected — user content outside the block survives, a file left empty is
/// deleted, a file without a block is not touched at all.
///
/// Downgrade guard (change instruction-downgrade-guard): before any write, the skill files
/// this call is ABOUT to regenerate are checked for direction — a frontmatter version
/// leading this engine means regenerating would silently rewrite them back to older content,
/// the 2026-08-05 incident. The check is sourced from the write set itself (tools list,
/// legacy directory detection, custom descriptors), not from the builtin-only probe, so no
/// regeneration corner escapes it. Every regeneration path (CLI update, workflow-config sync
/// on both CLI and desktop, the desktop update entry, tool reconciliation) funnels through
/// here, so the guard lives here and nowhere else; `allow_downgrade` is the single explicit
/// override.
///
/// The spec directory migration (spec-dir-migration D5) runs after the guard and before
/// the sync, so the skills render against the folder the project ends up with;
/// [`sync_skills`] is the same sync without it.
pub fn update(root: &Path, allow_downgrade: bool) -> Result<UpdateOutcome> {
    sync(root, allow_downgrade, crate::migrate::plan)
}

/// [`update`] without the spec directory migration — the skill sync behind a worktree
/// policy switch (desktop-spec-dir-migration D6). A settings write is no moment for the
/// folder to move: the migration stays with `update`, whose callers show what moved and
/// what to do next. The downgrade guard still applies.
pub fn sync_skills(root: &Path) -> Result<UpdateOutcome> {
    sync(root, false, |_, _| crate::migrate::MigrationPlan::Nothing)
}

/// The sync behind both entries; `plan_migration` decides what happens to the spec folder.
fn sync(
    root: &Path,
    allow_downgrade: bool,
    plan_migration: fn(&Path, &crate::config::AppConfig) -> crate::migrate::MigrationPlan,
) -> Result<UpdateOutcome> {
    let app = crate::config::AppConfig::load(&root.join(".specseal.yaml"))?;
    let (spec_dir, _) = resolve_spec_dir(root, app.spec_dir.as_deref());
    let selection = ToolSelection::resolve(root, &app);
    // 坏描述子＝零写入：错误在任何文件动作之前转出来。
    if let Some(message) = &selection.descriptor_error {
        bail!("{message}");
    }
    let location = spec_location(&app);
    let plan = SyncPlan::resolve(root, selection, &spec_dir, location);
    if allow_downgrade {
        plan.refuse_shared_skill_dirs()?;
    } else {
        plan.guard()?;
    }
    let migration = plan_migration(root, &app);
    let migrated = crate::migrate::apply(root, &migration)?;
    // 守门面只取决于选集；搬完文件夹后以实际文件夹重新解析写入用的计划。
    let plan = if migrated.moved_folder {
        SyncPlan::resolve(root, ToolSelection::resolve(root, &app), DEFAULT_SPEC_DIR, location)
    } else {
        plan
    };
    let mut outcome = plan.apply(root)?;
    outcome.migration = migration;
    outcome.migrated = migrated;
    Ok(outcome)
}

/// Converge a workspace on `tools` as the COMPLETE desired state of its built-ins —
/// the desktop settings page, checkout binding and [`adopt`] share this entry.
///
/// Two steps: `.specseal.yaml`'s built-in entries are rewritten to match the
/// selection (custom descriptors, remote, spec_dir and unknown keys carry over
/// untouched), then [`SyncPlan::apply`] — the writer every entry shares — generates the
/// selected tools' skills, prunes the deselected ones and strips any legacy
/// instruction-file marker.
///
/// Empty selections and malformed configs fail before anything is written. Beyond that
/// there is no rollback: every managed write is idempotent, so the same selection can be
/// submitted again to converge (design: "失败不打开 Workspace并以可重试收敛取代跨档回滚").
pub fn reconcile_builtin_tools(root: &Path, tools: &[Tool]) -> Result<UpdateOutcome> {
    if tools.is_empty() {
        bail!("no tools selected (supported: {})", Tool::supported_names());
    }
    let path = root.join(".specseal.yaml");
    let original = util::read_opt(&path).unwrap_or_default();
    let rewritten = crate::config::update_app_config_tools_text(&original, tools)?;
    // 选集与计划都由改写后的文本创建：守门目标与其后的写入集同源，拒绝＝整体
    // 零写入，不留「config 已改、受管档未同步」的半状态。
    let app: crate::config::AppConfig = crate::config::parse_lenient_or_reason(&rewritten)
        .map_err(|reason| anyhow::anyhow!("invalid .specseal.yaml: {reason}"))?;
    let (spec_dir, _) = resolve_spec_dir(root, app.spec_dir.as_deref());
    let selection = ToolSelection::resolve(root, &app);
    if let Some(message) = &selection.descriptor_error {
        bail!("{message}");
    }
    let plan = SyncPlan::resolve(root, selection, &spec_dir, spec_location(&app));
    plan.guard()?;
    util::write_file(&path, &rewritten)?;
    plan.apply(root)
}

/// Adopt specseal in a directory that already has a spec folder but no `.specseal.yaml`
/// — the workspace backfill entry (change: desktop-enable-specseal-prompt, 决策 2).
/// An OpenSpec project (`openspec/` and no `specseal/`) is imported first, exactly as
/// `init` imports it (desktop-spec-dir-migration D3): the same checks, refusing with zero
/// writes when one fails, then the move to `specseal/`. Then composes [`store_init`]'s
/// idempotent skeleton fill (directories via create_dir_all; the workflow-config template
/// only when config.yaml is absent — an existing file with user policy is never touched)
/// with [`reconcile_builtin_tools`] (tools recorded in `.specseal.yaml`, managed skills
/// regenerated). Deliberately NOT behind `init`'s "Already initialized" guard. An empty
/// selection is rejected before anything is written.
///
/// `.gitignore` is covered here explicitly: the `reconcile_builtin_tools` → `update`
/// path does not touch it (only `init` itself does), so without this the
/// gitignored work directory would surface as untracked files in the user's repo.
pub fn adopt(root: &Path, tools: &[Tool]) -> Result<UpdateOutcome> {
    if tools.is_empty() {
        bail!("no tools selected (supported: {})", Tool::supported_names());
    }
    if crate::migrate::needs_import(root) {
        import_openspec(root, tools)?;
    } else {
        // 与导入路径相同：守门在骨架与 .gitignore 写入之前，拒绝＝零写入。
        let spec_dir = resolve_spec_dir(root, None).0;
        SyncPlan::resolve(root, ToolSelection::builtins_only(tools), &spec_dir, SpecLocation::InCheckout).guard()?;
    }
    store_init(&root.join(resolve_spec_dir(root, None).0), false)?;
    ensure_gitignore(&root.join(".gitignore"))?;
    reconcile_builtin_tools(root, tools)
}

/// Recorded footprint of a generated custom tool — what a later update needs in order to
/// clean up after the descriptor disappears from `.specseal.yaml`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CustomFootprint {
    name: String,
    skills_dir: String,
    /// Deprecated and optional — kept so a descriptor that still names one keeps a
    /// prune/strip target after it falls off the tools list.
    #[serde(default)]
    instructions_file: Option<String>,
}

/// Host-side record of generated custom-tool footprints (`.specseal/` is gitignored work
/// data). Missing or unreadable state simply means "nothing to prune".
fn custom_state_path(root: &Path) -> PathBuf {
    root.join(".specseal").join("generated-tools.yaml")
}

fn load_custom_state(root: &Path) -> Vec<CustomFootprint> {
    let Some(text) = util::read_opt(&custom_state_path(root)) else {
        return Vec::new();
    };
    serde_yaml::from_str(&text).unwrap_or_default()
}

fn save_custom_state(root: &Path, customs: &[CustomTool]) -> Result<()> {
    let footprints: Vec<CustomFootprint> = customs
        .iter()
        .map(|c| CustomFootprint {
            name: c.name.clone(),
            skills_dir: c.skills_dir.clone(),
            instructions_file: c.instructions_file.clone(),
        })
        .collect();
    if footprints.is_empty() {
        // No footprints → no state file (and drop .specseal/ if that leaves it empty).
        let path = custom_state_path(root);
        if path.exists() {
            std::fs::remove_file(&path)?;
            if let Some(parent) = path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        return Ok(());
    }
    util::write_file(&custom_state_path(root), &serde_yaml::to_string(&footprints)?)?;
    Ok(())
}

/// Whether worktree-gated skills belong in the generation set, by the workflow config's
/// text: a local project's `config.yaml` in its spec folder, or the config of the scope a
/// Server answers for. No text is the defaults (off).
///
/// It reads the `worktree` key DIRECTLY rather than through the three-layer policy
/// resolution: injection is the project's persistent state, while `SPECSEAL_WORKTREE` is a
/// per-run escape hatch for the skill's own runtime check.
///
/// A config that exists but cannot be parsed keeps the skills. Pruning is the
/// irreversible direction — a user who broke their config mid-flight must not lose the
/// merge skill their open worktree depends on; the skill's runtime check still refuses
/// to run under an off policy.
pub fn worktree_skills_on(workflow_config: Option<&str>) -> bool {
    match crate::config::WorkflowConfig::from_text(workflow_config) {
        Ok(cfg) => cfg.worktree.unwrap_or(false),
        Err(_) => true,
    }
}

/// Prune a recorded custom footprint. Paths are re-checked against the project root before
/// any removal — a tampered state file must not be able to delete outside the project.
fn prune_custom(root: &Path, fp: &CustomFootprint, notes: &mut Vec<String>) -> Result<bool> {
    if !crate::config::is_project_relative(&fp.skills_dir)
        || fp
            .instructions_file
            .as_deref()
            .is_some_and(|f| !crate::config::is_project_relative(f))
    {
        notes.push(format!(
            "skipped pruning tool '{}': recorded paths escape the project root",
            fp.name
        ));
        return Ok(false);
    }
    prune_footprint(
        root,
        &fp.skills_dir,
        fp.instructions_file.as_ref().map(|f| root.join(f)).as_deref(),
    )
}

/// update 的孤儿清理（spec: update 清除孤儿技能目录）：清掉 skills 目录下
/// specseal- 前缀、不在本次应生成集合的目录——改名或下架的技能不留旧目录。
/// 前缀即所有权，与 prune_footprint 同一判准；非前缀的用户目录不动。
/// 挂在 `SyncPlan::apply`，所以每个再生入口（含 init）都清。
fn prune_orphan_skills(skills_root: &Path, expected: &[String]) -> Result<()> {
    if let Ok(entries) = std::fs::read_dir(skills_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("specseal-")
                && !expected.iter().any(|e| e == &name)
                && entry.path().is_dir()
            {
                std::fs::remove_dir_all(entry.path())?;
            }
        }
    }
    Ok(())
}

/// Remove the generated artifacts of a deselected built-in tool.
fn prune_tool(root: &Path, tool: Tool) -> Result<bool> {
    // 指令档的遗留剥除已由 update() 对有指令档的内置工具无条件跑过（选取与否都剥），
    // 这里只清技能足迹——同一文件不需要第二个剥除点。
    prune_footprint(root, tool.skills_dir(), None)
}

/// Remove a generated footprint: specseal-* skill directories and any legacy SPECSEAL
/// marker block left in the instruction file. Returns whether anything was removed.
fn prune_footprint(root: &Path, skills_dir: &str, md: Option<&Path>) -> Result<bool> {
    let mut removed = false;
    let skills_root = root.join(skills_dir);
    let skills_root = skills_root.as_path();
    // A skills dir reached through a link — the dir itself (`.github/skills` →
    // `.claude/skills`) or a parent (`.cursor` → `.claude`) — points at another tool's
    // files: pruning through it would delete what that tool just wrote.
    if !passes_through_symlink(root, skills_dir) {
        if let Ok(entries) = std::fs::read_dir(skills_root) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("specseal-") && entry.path().is_dir() {
                    std::fs::remove_dir_all(entry.path())?;
                    removed = true;
                }
            }
        }
    }
    // A deselected tool should leave no footprint: drop the skills dir and its parent
    // when this prune emptied them — user files keep them alive, and a dir that was
    // already empty is not ours to remove.
    if removed {
        let _ = std::fs::remove_dir(skills_root);
        if let Some(parent) = skills_root.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
    if let Some(md) = md {
        if strip_legacy_marker(md)? {
            removed = true;
        }
    }
    Ok(removed)
}

/// One skills directory as the shared-directory check sees it.
struct SharedDirEntry {
    /// Where the directory really is, links followed.
    resolved: PathBuf,
    /// Whether any part of the path below the project root is a symlink.
    linked: bool,
    /// Project-root-relative path, as the error message names it.
    rel: String,
    label: String,
}

/// How many links [`resolved_dir`] follows by hand before it gives up — a loop of links
/// must not hang the sync.
const MAX_LINK_HOPS: usize = 40;

/// `path` with every symlink followed: the deepest part that exists is canonicalized and
/// the parts that do not exist yet are appended as they are, so a skills directory that
/// sync has not created yet still compares correctly. A link whose target does not exist
/// yet is followed by hand (`read_link`): sync would create the target, not the link.
fn resolved_dir(path: &Path) -> PathBuf {
    resolve_following_links(path, 0)
}

fn resolve_following_links(path: &Path, hops: usize) -> PathBuf {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        if let Ok(real) = existing.canonicalize() {
            return missing.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        if hops < MAX_LINK_HOPS {
            if let Ok(target) = std::fs::read_link(existing) {
                let base = existing.parent().unwrap_or(Path::new(""));
                let followed = resolve_following_links(&base.join(target), hops + 1);
                return missing.iter().rev().fold(followed, |acc, part| acc.join(part));
            }
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Whether any part of `rel` below `root` is a symlink. The root itself and the folders
/// above it do not count (macOS puts temp folders behind `/var` → `/private/var`).
fn passes_through_symlink(root: &Path, rel: &str) -> bool {
    let mut path = root.to_path_buf();
    Path::new(rel).components().any(|part| {
        path.push(part);
        std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink())
    })
}

/// Strip a legacy `SPECSEAL:START..END` block from an instruction file (design D2):
/// only the block and its separating blank line go, user content outside it survives,
/// a file left empty is deleted, and a file WITHOUT a block is not written at all
/// (byte-identical). Returns whether anything was stripped.
fn strip_legacy_marker(md: &Path) -> Result<bool> {
    let Some(text) = util::read_opt(md) else {
        return Ok(false);
    };
    if !text.contains("<!-- SPECSEAL:START") {
        return Ok(false);
    }
    let stripped = strip_marker(&text);
    if stripped == text {
        // 不成对的 START：strip_marker 原样退回，不动文件也不列入剥除摘要。
        return Ok(false);
    }
    if stripped.trim().is_empty() {
        std::fs::remove_file(md)?;
    } else {
        util::write_file(md, &stripped)?;
    }
    Ok(true)
}

/// Remove every paired SPECSEAL:START..END block (plus the blank line each was
/// separated by). An unpaired START — the END line hand-deleted or mangled by a
/// merge — returns the text unchanged: eating everything after START would be
/// silent data loss, and a stray block of dead text is the safer failure.
fn strip_marker(text: &str) -> String {
    let start = "<!-- SPECSEAL:START";
    let end = "<!-- SPECSEAL:END -->";
    let mut out = text.to_string();
    while let Some(s) = out.find(start) {
        let Some(e) = out[s..].find(end).map(|i| s + i + end.len()) else {
            // 不成对：整段放弃，已剥掉的前段（若有）保留——每一段都是独立成对判定。
            break;
        };
        let after = out[e..].trim_start_matches(|c| c == '\n' || c == '\r');
        out = format!("{}{}", &out[..s], after);
    }
    out
}

/// Detect installed AI tools by their footprints, WITHOUT any fallback — an empty result
/// means "no footprint found", which desktop checkout preselection needs (it must not
/// invent a Claude default). [`detect_tools`] layers the claude fallback on top.
pub fn detect_footprint_tools(root: &Path) -> Vec<Tool> {
    let mut out = Vec::new();
    if root.join(".claude").is_dir() {
        out.push(Tool::Claude);
    }
    if root.join(".agents").is_dir() || root.join("AGENTS.md").is_file() {
        out.push(Tool::Codex);
    }
    out
}

/// Detect installed AI tools by their footprints (legacy fallback path only — `init`
/// itself requires an explicit tool selection). Defaults to claude when nothing is found.
pub fn detect_tools(root: &Path) -> Vec<Tool> {
    let mut out = detect_footprint_tools(root);
    if out.is_empty() {
        out.push(Tool::Claude);
    }
    out
}

fn write_if(path: &Path, content: &str, force: bool) -> Result<()> {
    if path.exists() && !force {
        return Ok(());
    }
    util::write_file(path, content)?;
    Ok(())
}

/// Ensure `.gitignore` covers the `.specseal/` work directory, appending the
/// standard block when it does not. Returns whether the file was amended —
/// the context materializer turns that into a warning (never a silent write
/// of an unignored projection).
pub fn ensure_gitignore(path: &Path) -> Result<bool> {
    match util::read_opt(path) {
        Some(text) if text.contains(".specseal/") => Ok(false),
        Some(text) => {
            let mut new = text;
            if !new.ends_with('\n') {
                new.push('\n');
            }
            new.push('\n');
            new.push_str(GITIGNORE_BLOCK);
            util::write_file(path, &new)?;
            Ok(true)
        }
        None => {
            util::write_file(path, GITIGNORE_BLOCK)?;
            Ok(true)
        }
    }
}

/// 技能档过期探测的整体判定（规格「技能档过期探测」五态）。聚合优先序
/// 较新 > 缺失 > 过期 > 现版：较新排最前，只要有任何文件领先引擎，就不提供
/// 任何会改写它的动作；缺失优先于过期，因为「从未安装」与「装了但旧了」是不同
/// 的用户情境，提示文案据此分流。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetStatus {
    /// tools 清单声明的工具其 skills 目录下无任何 specseal- 技能档＝从未安装
    /// 或整组移除（如 clone 后技能未进版控）。
    Missing,
    /// 任一工具的技能版号与现版不等且不领先现版。
    Stale,
    /// 任一工具的技能版号数值新于现版＝工作区文件领先引擎（本体是旧版）。
    Newer,
    Current,
    /// 设置解析失败或技能档存在但读取错误——不得与现版混同。
    Unknown,
}

/// 单一内置工具的探测结果。`workspaceVersion` 为 None 代表技能整组不在（`missing`
/// 为真），或技能档在但 frontmatter 读不到版本行。`stale` 与 `newer` 互斥：方向
/// 由引擎判定，消费端不重算。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAssetState {
    pub tool: String,
    pub workspace_version: Option<String>,
    pub stale: bool,
    pub newer: bool,
    pub missing: bool,
}

/// 探测回报（决策 3）：目前引擎版本、逐工具状态，以及「更新将新建或改写且内容
/// 与现版 render 不同」的受管档清单（项目根相对路径）。清单不区分「过期」与
/// 「用户自订」——系统无历史 render，无从分辨。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProbe {
    pub status: AssetStatus,
    pub current_version: String,
    pub tools: Vec<ToolAssetState>,
    pub differing_files: Vec<String>,
    /// What `update` would do about the spec folder (desktop-spec-dir-migration D1).
    pub migration: crate::migrate::MigrationProbe,
}

/// 读取技能档 frontmatter 的版本字段（`  version: "v1.2.3"`）；读不到回 None。
/// 搜索范围限定 frontmatter 本体：第一行的 `---` 到下一个 `---` 之间，body 里
/// 恰好叫 version: 的内文行不会被误认。
fn skill_version_of(text: &str) -> Option<&str> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let line = lines
        .take_while(|l| l.trim() != "---")
        .find(|l| l.trim_start().starts_with("version:"))?;
    let value = line.split_once("version:")?.1.trim().trim_matches('"');
    (!value.is_empty()).then_some(value)
}

/// 一个工具的 skills 目录探测结果——三态，因为「整组不在」「档在读不出」
/// 「读到了」对应到三种不同的回报状态，混同任两者都会误导提示层。
enum SkillsProbe {
    /// 目录下无任何 specseal- 技能档（目录不存在也算：从未安装或整组移除）。
    Absent,
    /// 找到技能档且读得到 frontmatter 版号。
    Found(String),
    /// 技能档存在但读不出版号（IO 失败、目录不可枚举、frontmatter 版本行遗失）
    /// ——「无法判定」，不得与现版或缺失混同。
    Unreadable,
}

/// 取一个 skills 目录的产物层版号。同一次生成的所有技能档带相同版号（规格
///「产物层版本戳同源」），但工作区可能是半手动状态，所以整个目录逐份扫描而不
/// 抽样一份：守门的契约是「即将被改写的技能档中任一档领先即拒绝」，抽样会漏。
/// 回传最能代表方向的版号——任一档领先引擎即回该档（领先优先），否则回第一个
/// 与现版不等的版号，全部现版时回现版。目录项目排序后扫描，结果与文件系统的
/// 枚举顺序无关。`base` 是比较的基准版号：本机的探测与守门给引擎现版，Server 给的
/// 技能给 Server 的版号。
fn probe_skills_dir(skills_root: &Path, base: &str) -> SkillsProbe {
    let entries = match std::fs::read_dir(skills_root) {
        Ok(entries) => entries,
        // 目录不存在＝从未安装；其他失败（权限、路径是文件）＝无法判定。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SkillsProbe::Absent,
        Err(_) => return SkillsProbe::Unreadable,
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("specseal-"))
        .collect();
    names.sort();
    let mut found_any = false;
    let mut differing: Option<String> = None;
    let mut current: Option<String> = None;
    for name in names {
        let file = skills_root.join(&name).join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            return SkillsProbe::Unreadable;
        };
        // 档在但版本行读不到＝坏 frontmatter：回报成现版会让它永远不被修复。
        let Some(v) = skill_version_of(&text).map(str::to_string) else {
            return SkillsProbe::Unreadable;
        };
        found_any = true;
        if is_newer_version(&v, base) {
            return SkillsProbe::Found(v);
        }
        if v != base {
            differing.get_or_insert(v);
        } else {
            current.get_or_insert(v);
        }
    }
    if !found_any {
        return SkillsProbe::Absent;
    }
    SkillsProbe::Found(differing.or(current).expect("found_any implies a version"))
}

/// 比对前范式换行：Windows checkout（core.autocrlf）的 CRLF 文件不得因换行
/// 形式被误报为内容有异。
fn eol_normalized(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// The digest of a skill file's text, as the wire carries it: `sha256:` and the hex
/// SHA-256 of the text with its line ends as LF, so a CRLF checkout of the same file
/// gives the same value.
pub fn skill_digest(content: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("sha256:{:x}", Sha256::digest(eol_normalized(content).as_bytes()))
}

/// 版号拆段：去 v 前缀、以点号拆段、逐段解析为数字；任一段非纯数字即回 None
///（不排序无法解析的版号）。
fn version_parts(version: &str) -> Option<Vec<u64>> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|seg| seg.parse::<u64>().ok())
        .collect()
}

/// Whether skill template version `version` is numerically newer than `than`
/// (`v1.58.0` over `v1.57.0`): the segments are compared as numbers, and a missing
/// segment counts as zero. False when either side does not parse as numbers — a
/// frontmatter someone broke by hand may read as stale (a rewrite makes it managed
/// again), but never as newer (that would block `update`).
pub fn is_newer_version(version: &str, than: &str) -> bool {
    let (Some(a), Some(b)) = (version_parts(version), version_parts(than)) else {
        return false;
    };
    for i in 0..a.len().max(b.len()) {
        let (l, r) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if l != r {
            return l > r;
        }
    }
    false
}

/// 降级守门的拒绝判定：`dirs` 中任一 skills 目录的技能版号数值领先引擎时，以单行
/// 英文错误拒绝（含两边版号）。技能不在、或版号读不出来的目录不挡——守门只在
/// 「可证明较新」时触发（决策 3 的安全缺省）。
fn refuse_downgrade(dirs: &[PathBuf]) -> Result<()> {
    for dir in dirs {
        if let Some(v) = leading_skill_version(dir, ASSET_VERSION) {
            bail!(
                "Workspace skill files ({v}) are newer than this engine ({ASSET_VERSION}). \
                 Update Specseal first, or run `specseal update --allow-downgrade` to rewrite them anyway."
            );
        }
    }
    Ok(())
}

/// The version of a skill file in `skills_root` that is numerically newer than `than`,
/// if any file's is. A directory without skills, or with a version that cannot be read,
/// leads nothing.
fn leading_skill_version(skills_root: &Path, than: &str) -> Option<String> {
    match probe_skills_dir(skills_root, than) {
        SkillsProbe::Found(v) if is_newer_version(&v, than) => Some(v),
        _ => None,
    }
}

/// 唯读的技能档过期探测（规格「技能档过期探测」）：依 `.specseal.yaml` 的 tools
/// 清单（与 [`update`] 同一数据源）读各内置工具 skills 目录下技能档 frontmatter 的
/// 版本字段，对 [`ASSET_VERSION`] 判方向——数值领先现版为较新，其余退回字符串相等
/// 判定（不等即过期）。方向是唯一判准来源：desktop 与 CLI 共用同一裁决，领先时
/// 两个出口都不提供改写动作。
///
/// 判定面为 tools 清单声明的内置工具与通过验证的自订描述子——受管档集合即判定面。
/// 两条分界：(1) 无效描述子不成为 target，探测结果不受它影响——探测是唯读提示面，
/// 「设置里有个坏描述子」不是技能档过期的信号，由 update 的错误负责告知；(2) 有效
/// target 的技能档存在但读不出（目录不可读、frontmatter 坏掉）＝无法判定，内置与
/// 描述子同一规则（规格「技能档过期探测」的第五态）。
///
/// 零写入：desktop 开项目时搭载，探测失败不得阻断打开。
pub fn probe_assets(root: &Path) -> AssetProbe {
    use crate::migrate::MigrationProbe;
    let without_tools = |status: AssetStatus, migration: MigrationProbe| AssetProbe {
        status,
        current_version: ASSET_VERSION.to_string(),
        tools: Vec::new(),
        differing_files: Vec::new(),
        migration,
    };
    let Ok(app) = crate::config::AppConfig::load(&root.join(".specseal.yaml")) else {
        return without_tools(AssetStatus::Unknown, MigrationProbe::None);
    };
    // 与 update 同源的迁移判定；技能档现版时照样回报（提示由它单独触发）。
    let migration = crate::migrate::probe(root, &app);
    let (spec_dir, _) = resolve_spec_dir(root, app.spec_dir.as_deref());
    let selection = ToolSelection::resolve(root, &app);
    // 探测只读 tools 清单声明的工具：没有清单就没有受管工具可查（目录侦测的回退
    // 是 update 的再生规则，不是探测的判定面）。
    if selection.legacy_fallback {
        return without_tools(AssetStatus::Current, migration);
    }
    let plan = SyncPlan::resolve(root, selection, &spec_dir, spec_location(&app));

    let mut tools = Vec::new();
    for target in &plan.targets {
        let version = match probe_skills_dir(&target.skills_root, ASSET_VERSION) {
            SkillsProbe::Absent => {
                tools.push(ToolAssetState {
                    tool: target.label.clone(),
                    workspace_version: None,
                    stale: false,
                    newer: false,
                    missing: true,
                });
                continue;
            }
            // 技能档在但读不出版号（IO、坏 frontmatter）＝无法判定；
            // 与「不存在」是不同的状态。
            SkillsProbe::Unreadable => return without_tools(AssetStatus::Unknown, migration),
            SkillsProbe::Found(version) => version,
        };
        // 方向优先于相等判定：领先现版的版号是「较新」，不得再算成过期。
        let newer = is_newer_version(&version, ASSET_VERSION);
        tools.push(ToolAssetState {
            tool: target.label.clone(),
            stale: !newer && version != ASSET_VERSION,
            newer,
            missing: false,
            workspace_version: Some(version),
        });
    }

    let status = if tools.iter().any(|t| t.newer) {
        AssetStatus::Newer
    } else if tools.iter().any(|t| t.missing) {
        AssetStatus::Missing
    } else if tools.iter().any(|t| t.stale) {
        AssetStatus::Stale
    } else {
        AssetStatus::Current
    };
    let differing_files = match status {
        AssetStatus::Missing | AssetStatus::Stale | AssetStatus::Newer => plan.differing_files(),
        _ => Vec::new(),
    };

    AssetProbe {
        status,
        current_version: ASSET_VERSION.to_string(),
        tools,
        differing_files,
        migration,
    }
}

/// What a Server gives for one tool, by digest: the tool's name as the request sent
/// it, and each skill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServedSkills {
    pub tool: String,
    pub digests: Vec<SkillDigest>,
}

/// One skill of a Server's answer by digest: its name and the [`skill_digest`] of its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDigest {
    pub name: String,
    pub digest: String,
}

/// Check that a Server's answer fits a checkout's tools, before anything reads or writes
/// by it. `labels` are the selection's tools ([`ToolSelection::labels`]); `answer` is each
/// answered tool with its skill names. The answer must hold exactly those tools, each
/// once; a skill name must be a plain name ([`is_skill_name`]) and come once per tool.
fn check_answer(labels: &[String], answer: &[(&str, Vec<&str>)]) -> Result<()> {
    for (tool, names) in answer {
        if let Some(bad) = names.iter().find(|name| !is_skill_name(name)) {
            bail!("the server gave a skill name that is not a plain name for tool '{tool}': {bad:?}");
        }
        if let Some((_, name)) = names.iter().enumerate().find(|(i, name)| names[..*i].contains(name)) {
            bail!("the server gave skill '{name}' twice for tool '{tool}'");
        }
    }
    if let Some(label) = labels.iter().find(|label| !answer.iter().any(|(tool, _)| tool == label)) {
        bail!("the server gave no skills for tool '{label}'");
    }
    let extra = answer.iter().enumerate().find(|(i, (tool, _))| {
        !labels.iter().any(|label| label == tool) || answer[..*i].iter().any(|(earlier, _)| earlier == tool)
    });
    if let Some((_, (tool, _))) = extra {
        bail!("the server gave skills for tool '{tool}', which this checkout did not ask for");
    }
    Ok(())
}

/// [`probe_assets`] for a remote project, against what its Server gives instead of
/// this engine's own render (spec desktop-app「指令档过期提示」): no text is needed,
/// the digests decide. A tool with no skill file at all is missing; a skill whose
/// text differs, is absent, or is one the Server does not give makes the checkout
/// stale, and its file is listed; else it is current. A tool the Server gives no skill
/// at all is not compared. `version` is the Server's skill
/// version; `current_version` stays this engine's. Zero writes.
///
/// An answer that does not fit the checkout's tools (a tool absent, a tool that was
/// not asked for, a name that is no skill name) cannot be judged: unknown, never
/// current. A checkout without a tools list is not probed, as in [`probe_assets`].
pub fn probe_served_skills(root: &Path, version: &str, served: &[ServedSkills]) -> AssetProbe {
    let verdict = |status: AssetStatus, tools: Vec<ToolAssetState>, differing_files: Vec<String>| AssetProbe {
        status,
        current_version: ASSET_VERSION.to_string(),
        tools,
        differing_files,
        migration: crate::migrate::MigrationProbe::None,
    };
    let unknown = || verdict(AssetStatus::Unknown, Vec::new(), Vec::new());
    let Ok(app) = crate::config::AppConfig::load(&root.join(".specseal.yaml")) else {
        return unknown();
    };
    let selection = ToolSelection::resolve(root, &app);
    if selection.legacy_fallback {
        return verdict(AssetStatus::Current, Vec::new(), Vec::new());
    }
    let answer: Vec<(&str, Vec<&str>)> = served
        .iter()
        .map(|tool| (tool.tool.as_str(), tool.digests.iter().map(|skill| skill.name.as_str()).collect()))
        .collect();
    if check_answer(&selection.labels(), &answer).is_err() {
        return unknown();
    }
    // Where each tool keeps its skills. An invalid descriptor is no target, here as in
    // [`probe_assets`]; the files to compare with come from the Server's digests.
    let selection = ToolSelection { descriptor_error: None, ..selection };
    let Ok(plan) = SyncPlan::build(root, selection, |_| Ok::<_, std::convert::Infallible>(Vec::new()));
    if plan.refuse_shared_skill_dirs().is_err() {
        return unknown();
    }

    let (mut tools, mut differing) = (Vec::new(), Vec::new());
    for target in &plan.targets {
        let given = served.iter().find(|tool| tool.tool == target.label).map_or(&[][..], |tool| &tool.digests[..]);
        let workspace_version = || match probe_skills_dir(&target.skills_root, version) {
            SkillsProbe::Found(v) => Some(v),
            SkillsProbe::Absent | SkillsProbe::Unreadable => None,
        };
        // A tool the Server gives no skill is not compared (design D9): an install
        // leaves it alone, so nothing of it is missing, stale or extra.
        if given.is_empty() {
            tools.push(ToolAssetState {
                tool: target.label.clone(),
                workspace_version: workspace_version(),
                stale: false,
                newer: false,
                missing: false,
            });
            continue;
        }
        let dir_of = |skill: &SkillDigest| format!("specseal-{}", skill.name);
        let present = managed_skill_dirs(&target.skills_root);
        let file = |dir: &str| format!("{}/{dir}/SKILL.md", target.skills_dir);
        let before = differing.len();
        for skill in given {
            let dir = dir_of(skill);
            let text = std::fs::read_to_string(target.skills_root.join(&dir).join("SKILL.md")).ok();
            if text.map(|text| skill_digest(&text)).as_ref() != Some(&skill.digest) {
                differing.push(file(&dir));
            }
        }
        differing.extend(present.iter().filter(|dir| !given.iter().any(|skill| dir_of(skill) == **dir)).map(|dir| file(dir)));
        let missing = present.is_empty();
        tools.push(ToolAssetState {
            tool: target.label.clone(),
            workspace_version: workspace_version(),
            // Against a Server there is no direction: a tool whose files differ is stale.
            stale: !missing && differing.len() > before,
            newer: false,
            missing,
        });
    }
    let status = if tools.iter().any(|t| t.missing) {
        AssetStatus::Missing
    } else if differing.is_empty() {
        AssetStatus::Current
    } else {
        AssetStatus::Stale
    };
    verdict(status, tools, differing)
}

/// The `specseal-` folders under `skills_root` that hold a SKILL.md, sorted: the
/// managed skills a tool has now.
fn managed_skill_dirs(skills_root: &Path) -> Vec<String> {
    let mut dirs: Vec<String> = std::fs::read_dir(skills_root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("specseal-"))
        .collect();
    dirs.sort();
    dirs
}

/// 内置工具曾被注入 marker 的指令档路径（项目根相对）。copilot、pi、cursor 从未有
/// 指令档，没有遗留区块要剥除。
fn instructions_path(tool: Tool) -> Option<&'static str> {
    match tool {
        Tool::Claude => Some("CLAUDE.md"),
        Tool::Codex => Some("AGENTS.md"),
        Tool::Copilot | Tool::Pi | Tool::Cursor => None,
    }
}

/// Validate a comma-separated `--tools` value into a tool list. Specseal deliberately scopes
/// the supported tools to claude, codex, copilot, pi and cursor.
pub fn parse_tools(spec: &str) -> Result<Vec<Tool>> {
    parse_tool_names(&spec.split(',').collect::<Vec<&str>>())
}

/// Validate built-in tool NAMES into a deduplicated selection: blank entries are skipped,
/// an unknown name is a loud error. The CLI arrives here through [`parse_tools`] with a
/// comma-separated value, the desktop with a list — one rule, one message for both.
pub fn parse_tool_names<S: AsRef<str>>(names: &[S]) -> Result<Vec<Tool>> {
    let mut out = Vec::new();
    for name in names {
        let name = name.as_ref().trim();
        if name.is_empty() {
            continue;
        }
        match Tool::parse(name) {
            Some(t) => {
                if !out.contains(&t) {
                    out.push(t);
                }
            }
            None => bail!(
                "unknown tool: {name} (supported: {})",
                Tool::supported_names()
            ),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
