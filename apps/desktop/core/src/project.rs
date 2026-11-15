//! 打开项目：所选目录的四态判定（本机项目／remote binding／未初始化／错误）与未初始化目录的
//! 初始化。仅回报判定结果或运行 init——root 的切换由 Tauri 层的状态持有者决定。

use std::path::{Path, PathBuf};

use serde::Serialize;
use specseal_core::workspace::Workspace;

/// `open_project_at` 的判定结果——仅回报，不切换任何状态。
/// 串行化为 `{ "status": "project" | "remoteBinding" | "uninitialized", … }` 供前端分流。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum ProjectProbe {
    /// 向上探索命中 specseal 项目：`root` 为探索到的项目根、`name` 为其目录名。
    Project { root: String, name: String },
    /// 命中 `.specseal.yaml` 的 remote section；Desktop 必须走 remote handshake，
    /// 并以调用端原始 path 作为 checkoutRoot，不得把 marker 当成本机项目。
    RemoteBinding {
        url: String,
        repo: Option<String>,
        has_local_openspec: bool,
    },
    /// 目录存在且可读，但不属于任何 specseal 项目（前端据此开初始化确认框）。
    Uninitialized { dir: String },
    /// 向上探索命中且为本地文件模式、但项目根无 `.specseal.yaml`——有规格数据
    /// 但未激活 specseal（前端据此打开用确认框）。`root` 为命中的项目根；
    /// `needs_import`＝规格文件夹是旧布局 openspec/，激活会先把它改名为 specseal/
    /// （desktop-spec-dir-migration D3）。
    Unadopted { root: String, needs_import: bool },
}

/// 对所选目录做打开项目的四态判定：以该目录为起点沿用
/// `Workspace::discover` 向上探索（与 app 启动语意一致）。零写入。
/// 不存在或非目录的路径是单行 Err——必须在探索前拦下，否则已删除路径
/// 会经祖先误命中别的项目（分页失效态依赖这个判定）。
pub fn open_project_at(path: &Path) -> Result<ProjectProbe, String> {
    if !path.is_dir() {
        return Err(format!(
            "cannot open '{}': not an existing directory",
            path.display()
        ));
    }
    match Workspace::discover(path) {
        Ok(Some(ws)) => {
            let resolution = ws.resolve_mode_with(None).map_err(|e| e.to_string())?;
            match resolution.mode {
                specseal_core::workspace::StoreMode::Remote(remote) => {
                    Ok(ProjectProbe::RemoteBinding {
                        url: remote.url,
                        repo: remote.repo,
                        has_local_openspec: resolution.coexists,
                    })
                }
                // 第四态（desktop-enable-specseal-prompt 决策 1）：Fs 模式且 root 无
                // .specseal.yaml → 未激活。旧版 remote 标记档的迁移警告路径冻结——
                // 带 leftover 标记者照旧判 Project，不得误判成未激活。
                specseal_core::workspace::StoreMode::Fs
                    if !ws.root.join(".specseal.yaml").is_file()
                        && !resolution.leftover_remote_file =>
                {
                    Ok(ProjectProbe::Unadopted {
                        root: ws.root.display().to_string(),
                        needs_import: specseal_core::migrate::needs_import(&ws.root),
                    })
                }
                specseal_core::workspace::StoreMode::Fs => Ok(ProjectProbe::Project {
                    name: project_name(&ws.root),
                    root: ws.root.display().to_string(),
                }),
            }
        }
        Ok(None) => Ok(ProjectProbe::Uninitialized {
            dir: path.display().to_string(),
        }),
        // 坏 .specseal.yaml：fail-closed 为单行 Err——不得误判为 Uninitialized
        // （否则前端会对既有项目开初始化确认框）。
        Err(e) => Err(e.to_string()),
    }
}

/// 项目显示名＝root 目录名（分页与顶栏用）；磁盘根等无目录名时退回完整路径。
pub fn project_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string())
}

/// 唯读回报指定项目 root 的待收尾数（spec-archive-drawer design D6 背景分页徽章快照）。
/// 不切换任何状态。待收尾＝等用户运行动词的卡片：已就绪（任务全完成，与看板
/// ready 栏派生一致）变更数＋concluded 未转出讨论数（promoted 已转出、open 仍在
/// 推进，皆不计）。路径失效回单行 Err；且探索命中的 root 必须就是 `path` 本身——
/// openspec/ 已删但目录还在时，向上探索会误命中祖先项目，不得回报别人的数字。
pub fn project_stats_at(path: &Path) -> Result<serde_json::Value, String> {
    match open_project_at(path)? {
        ProjectProbe::Project { root, .. } if root == path.display().to_string() => {}
        _ => {
            return Err(format!(
                "'{}' is no longer a specseal project root",
                path.display()
            ))
        }
    }
    let payload = crate::query::list_changes_at(path);
    let ready = payload["changes"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|c| {
                    let total = c["totalTasks"].as_u64().unwrap_or(0);
                    let done = c["completedTasks"].as_u64().unwrap_or(0);
                    total > 0 && done >= total
                })
                .count()
        })
        .unwrap_or(0);
    let discussions = crate::discussions::list_discussions_at(path);
    let concluded = discussions["active"]
        .as_array()
        .map(|items| items.iter().filter(|d| d["status"] == "concluded").count())
        .unwrap_or(0);
    Ok(serde_json::json!({ "pendingWrapUp": ready + concluded }))
}

/// 对未初始化目录运行与 `specseal init` 等效的初始化（design D3：消费
/// `specseal_core::init::init`，force=false、缺省规格文件夹 specseal/），成功后
/// 重跑三态判定回报命中的项目。`tools` 为内置工具名（claude／codex）；
/// 未知名在任何写入之前被拒，单行 Err。
pub fn init_project_at(path: &Path, tools: &[String]) -> Result<ProjectProbe, String> {
    let selected = specseal_core::init::parse_tool_names(tools).map_err(|e| e.to_string())?;
    specseal_core::init::init(path, &selected, false, specseal_core::workspace::DEFAULT_SPEC_DIR)
        .map_err(|e| e.to_string())?;
    open_project_at(path)
}

/// 对未激活目录运行工作区补齐（消费 `specseal_core::init::adopt`，决策 2；旧布局
/// openspec/ 先导入为 specseal/），成功后重跑探测回报命中的项目。`path` 为探测回报的项目根；未知工具名在
/// 任何写入之前被拒，单行 Err。
pub fn adopt_project_at(path: &Path, tools: &[String]) -> Result<ProjectProbe, String> {
    let selected = specseal_core::init::parse_tool_names(tools).map_err(|e| e.to_string())?;
    specseal_core::init::adopt(path, &selected).map_err(|e| e.to_string())?;
    open_project_at(path)
}

/// 唯读的技能档过期探测（desktop-instruction-staleness-prompt 决策 4）：单行委派
/// `specseal_core::init::probe_assets`，回报串行化为 camelCase JSON 供前端
/// 裁决是否显示提示。零写入、无 Err——探测失败以 status=unknown 表达，开项目
/// 不得被探测挡下。
pub fn probe_assets_at(path: &Path) -> serde_json::Value {
    let probe = specseal_core::init::probe_assets(path);
    serde_json::to_value(probe).expect("probe payload serializes")
}

/// 技能档整套再生（决策 5）：委派引擎既有的 `update()`——与 CLI 同一入口、幂等。
/// 引擎在写入前重探测方向，工作区领先时拒绝（desktop 无越过入口——降级只走 CLI 的
/// --allow-downgrade）；同一次调用也会剥除旧版引擎留下的指令档区块，并运行规格文件夹
/// 迁移（desktop-spec-dir-migration D2）。回报沿用 UpdateOutcome 形状加上 `migrated`；
/// 失败为单行 Err，由前端于提示原位呈现并可重试。
pub fn update_assets_at(path: &Path) -> Result<serde_json::Value, String> {
    let outcome =
        specseal_core::init::update(path, false).map_err(|e| single_line(&e.to_string()))?;
    Ok(update_outcome_payload(&outcome))
}

/// 更新动作回给前端的形状：本机与 remote 项目共用（remote 项目的更新由 Tauri 壳以
/// `specseal_remote::skills::install` 套用，回报经这里转成同一个形状）。
pub fn update_outcome_payload(outcome: &specseal_core::init::UpdateOutcome) -> serde_json::Value {
    serde_json::json!({
        "updated": outcome.updated,
        "pruned": outcome.pruned,
        "stripped": outcome.stripped,
        "deprecations": outcome.deprecations,
        "notes": outcome.notes,
        "migrated": {
            "movedFolder": outcome.migrated.moved_folder,
            "renamed": outcome.migrated.renamed,
        },
    })
}

/// remote 项目的技能档探测（remote-skill-delivery D6）：基准是 Server 提供的技能，
/// 用摘要比对，不需要全文。委派引擎的 `probe_served_skills`，回报和本机探测同形，
/// 另带两个值：`serverVersion`（Server 的技能版本）与 `appOlderThanServer`（这个 app
/// 内置的技能版号在数值上比 Server 旧；任一边读不出数字时为 false）。零写入。
pub fn probe_remote_assets_at(
    checkout: &Path,
    server_version: &str,
    served: &[specseal_core::init::ServedSkills],
) -> serde_json::Value {
    let probe = specseal_core::init::probe_served_skills(checkout, server_version, served);
    let mut value = serde_json::to_value(probe).expect("probe payload serializes");
    value["serverVersion"] = server_version.into();
    value["appOlderThanServer"] =
        specseal_core::init::is_newer_version(server_version, specseal_core::init::ASSET_VERSION).into();
    value
}

/// checkout 监看的一个挂载点：路径，以及要不要连同底下的文件夹一起监看。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchTarget {
    pub path: PathBuf,
    pub recursive: bool,
}

/// 有 checkout 的 remote 项目要监看什么（remote-skill-delivery D8）：技能档探测会读的东西，
/// 不是整个 checkout。
#[derive(Debug, Clone)]
pub struct SkillWatchTargets {
    /// checkout 的根。
    root: PathBuf,
    /// 挂载点。第一个是 checkout 的根（不递归）；其余每个都存在。
    pub mounts: Vec<WatchTarget>,
    /// 各工具的技能目录，相对于 checkout 的根。
    skills_dirs: Vec<PathBuf>,
    /// 其中推导时还不存在的：等它们出现。
    awaited: Vec<PathBuf>,
}

impl SkillWatchTargets {
    /// `relative`（相对于 checkout 的根）的变动和技能档的探测有没有关系：`.specseal.yaml`
    /// 本身、技能目录里的任何东西，或一个不在的技能目录的某一层上层——推导时还不存在的
    /// （它的出现代表技能目录可能跟着出现），以及现在不见了的（整个工具文件夹被删掉时，
    /// 只剩上层的事件能说明这件事）。根不递归的监看会看到根底下每一项的变动——`.git`、
    /// 原代码文件夹，在 Windows 上还有「还在的工具文件夹里多了一个文件」——这些都不算。
    pub fn concerns(&self, relative: &Path) -> bool {
        if relative == Path::new(".specseal.yaml") {
            return true;
        }
        if relative.as_os_str().is_empty() {
            return false;
        }
        self.skills_dirs.iter().any(|dir| {
            relative.starts_with(dir)
                || (dir.starts_with(relative) && (self.awaited.contains(dir) || !self.root.join(dir).is_dir()))
        })
    }
}

/// `checkout` 的监看目标：checkout 的根（不递归：`.specseal.yaml` 的改动、工具文件夹的
/// 出现），加上每个工具的技能目录（递归）。技能目录还不存在时，改成它最近一个存在的上层
/// （不递归，最远到根）。工具清单和探测用同一个选集；`.specseal.yaml` 读不出来时只有根。
pub fn skill_watch_targets_at(checkout: &Path) -> SkillWatchTargets {
    use specseal_core::config::AppConfig;
    use specseal_core::init::ToolSelection;
    let skills_dirs: Vec<PathBuf> = AppConfig::load(&checkout.join(".specseal.yaml"))
        .map(|app| ToolSelection::resolve(checkout, &app).skills_dirs().into_iter().map(PathBuf::from).collect())
        .unwrap_or_default();
    let mut mounts = vec![WatchTarget { path: checkout.to_path_buf(), recursive: false }];
    let mut awaited = Vec::new();
    for dir in &skills_dirs {
        let full = checkout.join(dir);
        let target = if full.is_dir() {
            WatchTarget { path: full, recursive: true }
        } else {
            awaited.push(dir.clone());
            let below_root = |path: &&Path| path.starts_with(checkout) && *path != checkout;
            match full.ancestors().skip(1).take_while(below_root).find(|path| path.is_dir()) {
                Some(ancestor) => WatchTarget { path: ancestor.to_path_buf(), recursive: false },
                None => continue,
            }
        };
        if !mounts.contains(&target) {
            mounts.push(target);
        }
    }
    SkillWatchTargets { root: checkout.to_path_buf(), mounts, skills_dirs, awaited }
}

/// 关于页的版本信息（desktop-about-page design D1）：一次回齐，前端不自行拼凑。
/// 引擎版号＝`ASSET_VERSION`（与 CLI `--version` 的 engine 同一个值）；平台与架构为
/// 显示文本（macOS／Windows／Linux、arm64／x64），拷贝版本信息与回报问题网址照用。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_version: String,
    pub engine_version: String,
    pub platform: String,
    pub arch: String,
}

/// `app_version` 由 Tauri 壳带入（`package_info().version`）。
pub fn app_info(app_version: &str) -> AppInfo {
    AppInfo {
        app_version: app_version.to_string(),
        engine_version: specseal_core::init::ASSET_VERSION.to_string(),
        platform: platform_label(std::env::consts::OS).to_string(),
        arch: arch_label(std::env::consts::ARCH).to_string(),
    }
}

/// 操作系统的显示文本；三大平台以外原样回传。
fn platform_label(os: &str) -> &str {
    match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

/// 架构的显示文本（与 CLI `--version` 的 arm64／x64 一致）；其余原样回传。
fn arch_label(arch: &str) -> &str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// 引擎错误压成单行（多行时取首行），符合 Err 单行消息契约。
fn single_line(msg: &str) -> String {
    msg.lines().next().unwrap_or(msg).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testfixture::FixtureRoot;
    use std::path::{Path, PathBuf};

    // --- 关于页的版本信息（desktop-about-page design D1） ---

    #[test]
    fn app_info_engine_version_matches_cli_engine() {
        // 与 CLI `--version` 的「engine vX.Y.Z」同一个值。
        let info = app_info("0.8.0");
        assert_eq!(info.app_version, "0.8.0");
        assert_eq!(info.engine_version, specseal_core::init::ASSET_VERSION);
        assert_eq!(info.platform, platform_label(std::env::consts::OS));
        assert_eq!(info.arch, arch_label(std::env::consts::ARCH));
    }

    #[test]
    fn app_info_serializes_camel_case_fields() {
        let value = serde_json::to_value(app_info("0.8.0")).unwrap();
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["appVersion", "arch", "engineVersion", "platform"]);
    }

    #[test]
    fn app_info_platform_and_arch_use_display_labels() {
        for (os, label) in [("macos", "macOS"), ("windows", "Windows"), ("linux", "Linux"), ("freebsd", "freebsd")] {
            assert_eq!(platform_label(os), label, "{os}");
        }
        for (arch, label) in [("aarch64", "arm64"), ("x86_64", "x64"), ("riscv64", "riscv64")] {
            assert_eq!(arch_label(arch), label, "{arch}");
        }
    }

    // --- 技能档探测与更新包装（desktop-instruction-staleness-prompt 决策 4、5） ---

    /// 以引擎 init 生成一个现版工作区（claude 单工具）。
    fn init_workspace(fx: &FixtureRoot, tools: &[&str]) {
        let owned: Vec<String> = tools.iter().map(|t| (*t).to_string()).collect();
        let selected = specseal_core::init::parse_tool_names(&owned).unwrap();
        specseal_core::init::init(fx.root(), &selected, true, specseal_core::workspace::DEFAULT_SPEC_DIR).unwrap();
    }

    /// 比现版领先一个主版号的版号（仿真工作区由更新的引擎生成）。
    fn ahead_of_current() -> String {
        let major: u64 = specseal_core::init::ASSET_VERSION
            .trim_start_matches('v')
            .split('.')
            .next()
            .and_then(|s| s.parse().ok())
            .expect("ASSET_VERSION 主版号可解析");
        format!("v{}.0.0", major + 1)
    }

    /// 把工作区每份 claude 技能档的 frontmatter 版号改成指定值。
    fn set_skill_version(fx: &FixtureRoot, version: &str) {
        specseal_core::testkit::set_skill_version(&fx.root().join(".claude").join("skills"), version);
    }

    fn propose_skill(fx: &FixtureRoot) -> PathBuf {
        fx.root()
            .join(".claude")
            .join("skills")
            .join("specseal-propose")
            .join("SKILL.md")
    }

    #[test]
    fn probe_assets_serializes_camel_case_fields() {
        // 前端消费的字段名（决策 3 回报形状）：currentVersion／stale／missing／
        // differingFiles／workspaceVersion 皆为 camelCase。
        let fx = FixtureRoot::new("probe-camel");
        init_workspace(&fx, &["claude"]);
        set_skill_version(&fx, "v0.9.0");

        let value = probe_assets_at(fx.root());
        assert_eq!(value["status"], "stale", "{value}");
        assert_eq!(value["currentVersion"], specseal_core::init::ASSET_VERSION);
        let tool = &value["tools"][0];
        assert_eq!(tool["tool"], "claude");
        assert_eq!(tool["workspaceVersion"], "v0.9.0");
        assert_eq!(tool["stale"], true);
        assert_eq!(tool["newer"], false);
        assert_eq!(tool["missing"], false);
        assert!(
            value["differingFiles"]
                .as_array()
                .expect("differingFiles 为数组")
                .iter()
                .any(|f| f == ".claude/skills/specseal-propose/SKILL.md"),
            "{value}"
        );
    }

    #[test]
    fn probe_assets_reports_newer_when_the_workspace_leads_the_engine() {
        // 较新态（app 本体是旧版）：status 值与 per-tool 的 newer 布尔都是前端契约
        // ——前端不重算方向，横幅据此拿掉所有改写动作。
        let fx = FixtureRoot::new("probe-camel-newer");
        init_workspace(&fx, &["claude"]);
        let ahead = ahead_of_current();
        set_skill_version(&fx, &ahead);

        let value = probe_assets_at(fx.root());
        assert_eq!(value["status"], "newer", "{value}");
        let tool = &value["tools"][0];
        assert_eq!(tool["newer"], true);
        assert_eq!(tool["stale"], false);
        assert_eq!(tool["workspaceVersion"], ahead);
    }

    #[test]
    fn probe_assets_reports_missing_for_an_uninstalled_tool() {
        // 缺失态（从未安装）也走同一形状，前端据此改用安装文案。
        let fx = FixtureRoot::new("probe-camel-missing");
        init_workspace(&fx, &["claude", "codex"]);
        std::fs::remove_dir_all(fx.root().join(".agents").join("skills")).unwrap();

        let value = probe_assets_at(fx.root());
        assert_eq!(value["status"], "missing", "{value}");
        let codex = value["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["tool"] == "codex")
            .expect("codex 在列");
        assert_eq!(codex["missing"], true);
        assert_eq!(codex["workspaceVersion"], serde_json::Value::Null);
    }

    #[test]
    fn update_assets_refuses_a_newer_workspace_with_zero_writes() {
        // 引擎端守门（不是 UI 状态）：横幅算出 stale 后文件才变新（git pull）、
        // 用户再按「更新」的 TOCTOU 窗口，也会在写入前被引擎重探测挡下。
        let fx = FixtureRoot::new("update-refuses-newer");
        init_workspace(&fx, &["claude"]);
        let ahead = ahead_of_current();
        set_skill_version(&fx, &ahead);
        let leading = std::fs::read_to_string(propose_skill(&fx)).unwrap();

        let err = update_assets_at(fx.root()).expect_err("领先的工作区必须被拒");
        assert!(!err.contains('\n'), "单行错误：{err}");
        assert!(err.contains(&ahead) && err.contains(specseal_core::init::ASSET_VERSION), "{err}");
        assert_eq!(
            std::fs::read_to_string(propose_skill(&fx)).unwrap(),
            leading,
            "拒绝＝零写入"
        );
    }

    #[test]
    fn update_assets_regenerates_and_reports_updated_tools() {
        // 决策 5：更新委派既有 update() 整套再生；回报沿用 UpdateOutcome 形状。
        let fx = FixtureRoot::new("update-instructions");
        init_workspace(&fx, &["claude"]);
        std::fs::remove_dir_all(propose_skill(&fx).parent().unwrap()).unwrap();

        let outcome = update_assets_at(fx.root()).expect("update ok");
        assert_eq!(outcome["updated"][0], "claude", "{outcome}");
        assert!(outcome["pruned"].as_array().unwrap().is_empty(), "{outcome}");
        // 再生后探测回到现版。
        assert_eq!(probe_assets_at(fx.root())["status"], "current");
    }

    // --- remote 项目：基准是 Server 提供的技能（remote-skill-delivery D6） ---

    use specseal_core::init::{managed_skills, skill_digest, ServedSkills, SkillDigest, ASSET_VERSION};
    use specseal_core::skills::{RenderTarget, SpecLocation, Tool};

    /// 连到远程项目的 checkout（claude 单工具），技能档是本机范本产生的。
    fn remote_checkout(fx: &FixtureRoot) {
        let url = "https://team.example.test/api/specseal/v1/projects/acme";
        specseal_core::init::init_remote(fx.root(), &[Tool::Claude], true, url, None).unwrap();
    }

    /// 和这个 app 同版的 Server 给 claude 的技能：（名称、全文）。
    fn served_texts() -> Vec<(String, String)> {
        let spec_dir = specseal_core::workspace::DEFAULT_SPEC_DIR;
        managed_skills(RenderTarget::Builtin(Tool::Claude), false, spec_dir, SpecLocation::Elsewhere)
            .into_iter()
            .map(|(dir, text)| (dir.trim_start_matches("specseal-").to_string(), text))
            .collect()
    }

    fn digests_of(texts: &[(String, String)]) -> Vec<ServedSkills> {
        let digests =
            texts.iter().map(|(name, text)| SkillDigest { name: name.clone(), digest: skill_digest(text) }).collect();
        vec![ServedSkills { tool: "claude".into(), digests }]
    }

    #[test]
    fn probe_remote_assets_is_current_when_the_checkout_holds_what_the_server_gives() {
        let fx = FixtureRoot::new("remote-probe-current");
        remote_checkout(&fx);
        let value = probe_remote_assets_at(fx.root(), ASSET_VERSION, &digests_of(&served_texts()));
        assert_eq!(value["status"], "current", "{value}");
        assert_eq!(value["currentVersion"], ASSET_VERSION, "你的 Specseal 版本");
        assert_eq!(value["serverVersion"], ASSET_VERSION, "Server 提供的技能版本");
        assert_eq!(value["appOlderThanServer"], false);
        assert_eq!(value["tools"][0]["workspaceVersion"], ASSET_VERSION);
        assert!(value["differingFiles"].as_array().unwrap().is_empty(), "{value}");
    }

    #[test]
    fn probe_remote_assets_lists_the_file_that_differs_from_the_server() {
        let fx = FixtureRoot::new("remote-probe-stale");
        remote_checkout(&fx);
        std::fs::write(propose_skill(&fx), "edited by hand\n").unwrap();
        let value = probe_remote_assets_at(fx.root(), ASSET_VERSION, &digests_of(&served_texts()));
        assert_eq!(value["status"], "stale", "{value}");
        assert_eq!(value["differingFiles"], serde_json::json!([".claude/skills/specseal-propose/SKILL.md"]));
    }

    #[test]
    fn probe_remote_assets_is_missing_without_any_skill_file() {
        let fx = FixtureRoot::new("remote-probe-missing");
        remote_checkout(&fx);
        std::fs::remove_dir_all(fx.root().join(".claude").join("skills")).unwrap();
        let served = served_texts();
        let value = probe_remote_assets_at(fx.root(), ASSET_VERSION, &digests_of(&served));
        assert_eq!(value["status"], "missing", "{value}");
        assert_eq!(value["tools"][0]["missing"], true);
        assert_eq!(value["differingFiles"].as_array().unwrap().len(), served.len(), "安装会新建的文件数");
    }

    #[test]
    fn probe_remote_assets_says_when_the_app_is_older_than_the_server() {
        let fx = FixtureRoot::new("remote-probe-older-app");
        remote_checkout(&fx);
        let ahead = ahead_of_current();
        let value = probe_remote_assets_at(fx.root(), &ahead, &digests_of(&served_texts()));
        assert_eq!(value["serverVersion"], ahead.as_str());
        assert_eq!(value["appOlderThanServer"], true, "{value}");
        // 版号读不出来时不说 app 比较旧。
        let unreadable = probe_remote_assets_at(fx.root(), "latest", &digests_of(&served_texts()));
        assert_eq!(unreadable["appOlderThanServer"], false);
    }

    // --- checkout 的监看目标（remote-skill-delivery D8） ---

    /// claude 与一个自订描述子（`.my-agent/skills`）的 remote checkout；只有 claude 的技能档存在。
    fn checkout_with_two_tools(fx: &FixtureRoot) {
        remote_checkout(fx);
        fx.write(
            ".specseal.yaml",
            "tools:\n  - claude\n  - name: my-agent\n    skills_dir: .my-agent/skills\nremote:\n  url: https://team.example.test/api/specseal/v1/projects/acme\n",
        );
    }

    fn mounts(fx: &FixtureRoot) -> Vec<(PathBuf, bool)> {
        skill_watch_targets_at(fx.root()).mounts.into_iter().map(|m| (m.path, m.recursive)).collect()
    }

    #[test]
    fn skill_watch_targets_are_the_root_and_each_tools_skills_directory() {
        let fx = FixtureRoot::new("watch-targets");
        checkout_with_two_tools(&fx);
        std::fs::create_dir_all(fx.root().join(".my-agent").join("skills")).unwrap();
        assert_eq!(
            mounts(&fx),
            [
                (fx.root().to_path_buf(), false),
                (fx.root().join(".claude").join("skills"), true),
                (fx.root().join(".my-agent").join("skills"), true),
            ],
            "根不递归；每个工具的技能目录递归"
        );
    }

    #[test]
    fn skill_watch_targets_fall_back_to_the_nearest_folder_that_exists() {
        let fx = FixtureRoot::new("watch-targets-missing");
        checkout_with_two_tools(&fx);
        // claude：`.claude` 在、`.claude/skills` 不在；my-agent：整个不在，最近的上层是根。
        std::fs::remove_dir_all(fx.root().join(".claude").join("skills")).unwrap();
        assert_eq!(
            mounts(&fx),
            [(fx.root().to_path_buf(), false), (fx.root().join(".claude"), false)],
            "上层不递归；根不重复"
        );
    }

    #[test]
    fn skill_watch_targets_are_only_the_root_when_the_config_cannot_be_read() {
        let fx = FixtureRoot::new("watch-targets-bad-config");
        checkout_with_two_tools(&fx);
        fx.write(".specseal.yaml", ": not yaml : [\n");
        assert_eq!(mounts(&fx), [(fx.root().to_path_buf(), false)]);
        // 设置档修好的那一次改动仍然要通知。
        assert!(skill_watch_targets_at(fx.root()).concerns(Path::new(".specseal.yaml")));
    }

    #[test]
    fn a_checkout_watch_concerns_the_config_and_the_skills_directories_only() {
        let fx = FixtureRoot::new("watch-concerns");
        checkout_with_two_tools(&fx);
        let targets = skill_watch_targets_at(fx.root());
        // claude 的技能目录存在；my-agent 的还不存在，它的上层出现时要重新探测。
        for path in [
            ".specseal.yaml",
            ".claude/skills/specseal-apply/SKILL.md",
            ".claude/skills",
            ".my-agent",
            ".my-agent/skills",
            ".my-agent/skills/specseal-apply",
        ] {
            assert!(targets.concerns(Path::new(path)), "{path}");
        }
        // `.claude` 本身的变动（例如里面多了一个设置档）不算：它的技能目录已经被监看。
        for path in
            ["", "src", "src/main.rs", ".git", ".git/index", ".claude", ".claude/settings.json", "README.md", ".specseal"]
        {
            assert!(!targets.concerns(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn a_checkout_watch_concerns_the_parent_of_a_skills_directory_that_is_gone() {
        let fx = FixtureRoot::new("watch-concerns-gone");
        checkout_with_two_tools(&fx);
        let targets = skill_watch_targets_at(fx.root());
        assert!(!targets.concerns(Path::new(".claude")), "技能目录还在：上层的变动不算");
        // 整个工具文件夹被删掉：只剩上层的事件能说明这件事。
        std::fs::remove_dir_all(fx.root().join(".claude")).unwrap();
        assert!(targets.concerns(Path::new(".claude")));
    }

    /// 旧布局项目：`.specseal.yaml` 没有 spec_dir、规格在 openspec/、一个旧文件名的
    /// 变更数据档，技能档为现版（不在 git 里，迁移没有暂缓条件）。
    fn legacy_workspace(fx: &FixtureRoot) {
        let selected = specseal_core::init::parse_tool_names(&["claude".to_string()]).unwrap();
        specseal_core::init::init(fx.root(), &selected, true, "openspec").unwrap();
        fx.write(".specseal.yaml", "tools: [claude]\n");
        fx.write("openspec/changes/demo/.openspec.yaml", "schema: spec-driven\n");
    }

    #[test]
    fn probe_assets_reports_the_pending_migration() {
        let fx = FixtureRoot::legacy("probe-migration");
        legacy_workspace(&fx);

        let value = probe_assets_at(fx.root());
        assert_eq!(value["status"], "current", "{value}");
        assert_eq!(
            value["migration"],
            serde_json::json!({ "state": "pending", "folder": "openspec", "metaFiles": 1 })
        );
    }

    #[test]
    fn update_assets_reports_the_folder_move() {
        // 需求「技能档提示承载规格文件夹迁移」：更新走引擎 update，回报迁移结果
        // 供对话框显示要 commit 的路径与提醒。
        let fx = FixtureRoot::legacy("update-migration");
        legacy_workspace(&fx);

        let outcome = update_assets_at(fx.root()).expect("update ok");
        assert_eq!(outcome["migrated"], serde_json::json!({ "movedFolder": true, "renamed": 1 }), "{outcome}");
        assert!(!fx.root().join("openspec").exists());
        assert!(fx.root().join("specseal/changes/demo/.meta.yaml").is_file());
        assert_eq!(probe_assets_at(fx.root())["migration"]["state"], "none");

        let again = update_assets_at(fx.root()).expect("second update ok");
        assert_eq!(again["migrated"], serde_json::json!({ "movedFolder": false, "renamed": 0 }), "{again}");
    }

    #[test]
    fn update_assets_on_a_broken_config_is_a_single_line_error() {
        let fx = FixtureRoot::new("update-instructions-bad");
        init_workspace(&fx, &["claude"]);
        std::fs::write(fx.root().join(".specseal.yaml"), "tools: [\n").unwrap();

        let err = update_assets_at(fx.root()).expect_err("must fail");
        assert!(!err.contains('\n'), "single line: {err:?}");
    }

    /// 不含任何 specseal 标记的空目录（自动清除）。系统 temp 目录本身不是
    /// specseal 项目，向上探索不会误命中。
    struct PlainDir(PathBuf);

    impl PlainDir {
        fn new(tag: &str) -> PlainDir {
            let dir = std::env::temp_dir().join(format!("specseal-dtplain-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            PlainDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for PlainDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    // --- open_project_at：三态判定（spec 需求「运行期切换项目 root」） ---

    /// 已激活项目标记（spec Scenario「已激活项目不出现激活对话框」的判准）：
    /// 项目根有 `.specseal.yaml` 才照旧判 Project。
    fn mark_adopted(fx: &FixtureRoot) {
        fx.write(".specseal.yaml", "tools:\n  - claude\n");
    }

    #[test]
    fn open_project_at_project_root_reports_root_and_name() {
        let fx = FixtureRoot::new("open-root");
        mark_adopted(&fx);
        let probe = open_project_at(fx.root()).expect("probe ok");
        match probe {
            ProjectProbe::Project { root, name } => {
                assert_eq!(root, fx.root().display().to_string());
                assert_eq!(name, fx.root().file_name().unwrap().to_string_lossy());
            }
            other => panic!("expected Project, got {other:?}"),
        }
    }

    #[test]
    fn open_project_at_subdir_walks_up_to_project_root() {
        // spec Scenario「自子目录向上探索至项目根」：子目录本身不含 openspec/。
        let fx = FixtureRoot::new("open-subdir");
        mark_adopted(&fx);
        let sub = fx.root().join("src").join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let probe = open_project_at(&sub).expect("probe ok");
        match probe {
            ProjectProbe::Project { root, .. } => {
                assert_eq!(root, fx.root().display().to_string());
            }
            other => panic!("expected Project, got {other:?}"),
        }
    }

    // --- 第四态：未激活（spec 需求「未激活文件夹经确认后补齐激活」；决策 1） ---

    #[test]
    fn open_project_at_openspec_without_app_config_reports_unadopted_with_zero_writes() {
        // 判准＝项目根 .specseal.yaml 存在与否：有 openspec/ 但无 .specseal.yaml
        // 的文件夹（自其他体系迁移、或队友未提交）不再静默判 Project。
        let fx = FixtureRoot::legacy("open-unadopted");
        let before = entries(fx.root());
        let probe = open_project_at(fx.root()).expect("probe ok");
        assert_eq!(
            serde_json::to_value(probe).unwrap(),
            serde_json::json!({
                "status": "unadopted",
                "root": fx.root().display().to_string(),
                "needsImport": true,
            })
        );
        assert_eq!(entries(fx.root()), before, "probe must not write anything");
    }

    #[test]
    fn open_project_at_specseal_without_app_config_needs_no_import() {
        // 需求「未激活文件夹经确认后补齐激活」：只有旧布局 openspec/ 才需要导入（改名）。
        let plain = PlainDir::new("open-unadopted-specseal");
        std::fs::create_dir_all(plain.path().join("specseal").join("changes")).unwrap();
        let probe = open_project_at(plain.path()).expect("probe ok");
        assert_eq!(serde_json::to_value(probe).unwrap()["needsImport"], false);
    }

    #[test]
    fn open_project_at_unadopted_subdir_anchors_the_walked_up_root() {
        // spec Scenario「子目录打开锚定项目根」：判定锚在 discover 命中的 root，
        // 非用户所选子目录。
        let fx = FixtureRoot::new("open-unadopted-subdir");
        let sub = fx.root().join("src").join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let probe = open_project_at(&sub).expect("probe ok");
        match probe {
            ProjectProbe::Unadopted { root, .. } => {
                assert_eq!(root, fx.root().display().to_string());
            }
            other => panic!("expected Unadopted, got {other:?}"),
        }
    }

    #[test]
    fn open_project_at_leftover_remote_file_keeps_reporting_project() {
        // design 风险「误把旧 remote 标记档文件夹判成未激活」：旧版
        // .specseal.remote.yaml 的迁移警告路径冻结——不得变成 unadopted。
        let fx = FixtureRoot::new("open-leftover-remote");
        fx.write(".specseal.remote.yaml", "url: https://legacy.example.test\n");
        let probe = open_project_at(fx.root()).expect("probe ok");
        match probe {
            ProjectProbe::Project { root, .. } => {
                assert_eq!(root, fx.root().display().to_string());
            }
            other => panic!("expected Project, got {other:?}"),
        }
    }

    #[test]
    fn open_project_at_non_project_reports_uninitialized_with_zero_writes() {
        let plain = PlainDir::new("open-uninit");
        let before = entries(plain.path());
        let probe = open_project_at(plain.path()).expect("probe ok");
        match probe {
            ProjectProbe::Uninitialized { dir } => {
                assert_eq!(dir, plain.path().display().to_string());
            }
            other => panic!("expected Uninitialized, got {other:?}"),
        }
        assert_eq!(entries(plain.path()), before, "probe must not write anything");
    }

    #[test]
    fn open_project_at_remote_marker_reports_binding_without_local_openspec() {
        let plain = PlainDir::new("open-remote");
        std::fs::write(
            plain.path().join(".specseal.yaml"),
            "remote:\n  url: https://spec.example.test/team/\n  repo: desktop\n",
        )
        .unwrap();

        let probe = open_project_at(plain.path()).expect("probe ok");
        assert_eq!(
            serde_json::to_value(probe).unwrap(),
            serde_json::json!({
                "status": "remoteBinding",
                "url": "https://spec.example.test/team/",
                "repo": "desktop",
                "hasLocalOpenspec": false,
            })
        );
    }

    #[test]
    fn open_project_at_remote_marker_and_openspec_reports_coexistence() {
        let fx = FixtureRoot::new("open-remote-coexists");
        fx.write(
            ".specseal.yaml",
            "remote:\n  url: https://spec.example.test\n  repo: desktop\n",
        );

        let probe = open_project_at(fx.root()).expect("probe ok");
        assert_eq!(
            serde_json::to_value(probe).unwrap(),
            serde_json::json!({
                "status": "remoteBinding",
                "url": "https://spec.example.test",
                "repo": "desktop",
                "hasLocalOpenspec": true,
            })
        );
    }

    #[test]
    fn open_project_at_malformed_remote_marker_fails_closed() {
        let plain = PlainDir::new("open-remote-bad-yaml");
        std::fs::write(plain.path().join(".specseal.yaml"), "remote: [\n").unwrap();

        let err = open_project_at(plain.path()).expect_err("broken marker must fail");
        assert!(err.contains(".specseal.yaml"), "error names marker: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
    }

    #[test]
    fn open_project_at_missing_path_is_a_single_line_error() {
        // 已删除的路径必须是 Err——即使其上层目录是一个 specseal 项目，
        // 也不得向上探索误命中（分页指向已消失路径的错误态依赖这点）。
        let fx = FixtureRoot::new("open-missing");
        let gone = fx.root().join("gone");
        let err = open_project_at(&gone).expect_err("must fail");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert!(err.contains("gone"), "must name the path: {err}");
    }

    #[test]
    fn open_project_at_file_path_is_an_error() {
        // 选择器理论上只回目录；防类型混淆——传进文件路径不得 panic 也不得误判。
        let fx = FixtureRoot::new("open-file");
        fx.write("note.txt", "not a dir");
        let err = open_project_at(&fx.root().join("note.txt")).expect_err("must fail");
        assert!(!err.contains('\n'), "single line: {err:?}");
    }

    // --- init_project_at：确认后自动初始化的文件效果（spec 需求「未初始化目录经确认后自动初始化」） ---

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    #[test]
    fn init_project_at_default_claude_creates_workspace_files() {
        // spec Scenario「确认后初始化并切入新项目」的文件效果逐项。
        let plain = PlainDir::new("init-claude");
        let probe = init_project_at(plain.path(), &["claude".into()]).expect("init ok");
        match probe {
            ProjectProbe::Project { root, .. } => {
                assert_eq!(root, plain.path().display().to_string());
            }
            other => panic!("expected Project after init, got {other:?}"),
        }
        let p = plain.path();
        assert!(p.join("specseal").join("specs").is_dir());
        assert!(p.join("specseal").join("changes").join("archive").is_dir());
        assert!(p.join("specseal").join("config.yaml").is_file());
        assert!(!p.join("openspec").exists(), "初始化不得创建 openspec/");
        let app = read(&p.join(".specseal.yaml"));
        assert!(!app.lines().any(|l| l.starts_with("spec_dir")), "缺省文件夹不写 spec_dir: {app}");
        assert!(app.contains("claude"), "tools must record claude: {app}");
        // spec Scenario「确认后初始化并切入新项目」：不产生 CLAUDE.md。
        assert!(!p.join("CLAUDE.md").exists(), "指令档不得生成");
        let skills = p.join(".claude").join("skills");
        assert!(skills.is_dir());
        assert!(std::fs::read_dir(&skills).unwrap().next().is_some(), "skills dir must not be empty");
        // 未加选 codex 时不得生成 codex 档。
        assert!(!p.join("AGENTS.md").exists());
        assert!(!p.join(".agents").exists());
    }

    #[test]
    fn init_project_at_with_codex_adds_agents_files() {
        // spec Scenario「勾选 codex 时生成对应工具档」。
        let plain = PlainDir::new("init-codex");
        init_project_at(plain.path(), &["claude".into(), "codex".into()]).expect("init ok");
        let p = plain.path();
        // spec Scenario「勾选 codex 时生成对应工具档」：技能档生成、AGENTS.md 不生成。
        assert!(!p.join("AGENTS.md").exists(), "指令档不得生成");
        assert!(p.join(".agents").join("skills").is_dir());
        let app = read(&p.join(".specseal.yaml"));
        assert!(app.contains("claude") && app.contains("codex"), "tools must record both: {app}");
    }

    #[test]
    fn init_project_at_with_copilot_only_adds_github_skills() {
        // spec Scenario「勾选 copilot 时生成对应工具档」的只选 copilot 情形。
        let plain = PlainDir::new("init-copilot");
        init_project_at(plain.path(), &["copilot".into()]).expect("init ok");
        let p = plain.path();
        assert!(p
            .join(".github")
            .join("skills")
            .join("specseal-propose")
            .join("SKILL.md")
            .is_file());
        for absent in ["CLAUDE.md", "AGENTS.md", ".claude", ".agents"] {
            assert!(!p.join(absent).exists(), "{absent} 不得生成");
        }
        assert!(!p.join(".github").join("copilot-instructions.md").exists());
        assert!(read(&p.join(".specseal.yaml")).contains("copilot"));
    }

    #[test]
    fn init_project_at_with_claude_and_copilot_adds_both_skill_sets() {
        // spec Scenario「勾选 copilot 时生成对应工具档」：缺省的 claude 再加勾 copilot。
        let plain = PlainDir::new("init-claude-copilot");
        init_project_at(plain.path(), &["claude".into(), "copilot".into()]).expect("init ok");
        let p = plain.path();
        for skills in [".claude", ".github"] {
            let propose = p.join(skills).join("skills").join("specseal-propose");
            assert!(propose.join("SKILL.md").is_file(), "{skills} 技能须生成");
        }
        assert!(!p.join(".github").join("copilot-instructions.md").exists());
        let app = read(&p.join(".specseal.yaml"));
        assert!(
            app.contains("claude") && app.contains("copilot"),
            "tools must record both: {app}"
        );
    }

    #[test]
    fn init_project_at_unwritable_target_is_a_single_line_error() {
        // 目标路径是文件 → 建骨架必然失败；Err 单行且不得 panic。
        let fx = FixtureRoot::new("init-unwritable");
        fx.write("blocker.txt", "occupied");
        let err = init_project_at(&fx.root().join("blocker.txt"), &["claude".into()])
            .expect_err("must fail");
        assert!(!err.contains('\n'), "single line: {err:?}");
    }

    #[test]
    fn init_project_at_over_a_specseal_entry_that_is_no_spec_folder_names_it() {
        // 探测判为未初始化（specseal 不是规格文件夹，例如同名的 repo clone）：错误要说清楚原因，
        // 不是误导的「Already initialized」。
        let plain = PlainDir::new("init-specseal-taken");
        std::fs::create_dir_all(plain.path().join("specseal").join("src")).unwrap();
        let err = init_project_at(plain.path(), &["claude".into()]).expect_err("must fail");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert!(err.contains("specseal") && err.contains("not a spec folder"), "{err}");
        assert!(!plain.path().join(".specseal.yaml").exists(), "零写入");
    }

    #[test]
    fn init_project_at_already_initialized_is_an_error() {
        // GUI 只对 uninitialized 判定开确认框；防御：对既有项目误调用不得覆写（force=false）。
        // 已激活的项目（.specseal.yaml 与规格文件夹都在）。
        let fx = FixtureRoot::new("init-already");
        fx.write(".specseal.yaml", "tools: [claude]\n");
        assert!(init_project_at(fx.root(), &["claude".into()]).is_err());
    }

    // --- project_stats_at：唯读待收尾数（spec-archive-drawer design D6 背景分页徽章快照） ---

    /// 鹰架版讨论记录（比照 discussions.rs 测试）。
    fn discussion_doc(slug: &str, topic: &str, status: &str, extra_fm: &str) -> String {
        format!(
            "---\ntopic: {topic}\nslug: {slug}\nstatus: {status}\n{extra_fm}created: 2026-01-02\n---\n\n\
             # Discussion: {topic}\n\n\
             ## Context\n\nFixture context.\n\n\
             ## Rounds\n\n\
             ## Conclusion\n\n**Decision**: something\n"
        )
    }

    #[test]
    fn project_stats_reports_pending_wrap_up_count() {
        // design D6：待收尾数＝已就绪（任务全完成）变更数＋concluded 未转出讨论数；
        // 进行中／proposed 变更与 promoted／open 讨论不计；inProgressChanges 字段移除
        //（唯一消费者 store.ts 同变更内改写）。
        let fx = FixtureRoot::new("stats-wrapup");
        mark_adopted(&fx);
        fx.add_change("ready-a", "schema: spec-driven\ncreated: 2026-07-01\n");
        fx.write("specseal/changes/ready-a/tasks.md", "- [x] 1.1 one\n- [x] 1.2 two\n");
        fx.add_change("ready-b", "schema: spec-driven\ncreated: 2026-07-01\n");
        fx.write("specseal/changes/ready-b/tasks.md", "- [x] 1.1 one\n");
        fx.add_change(
            "started-c",
            "schema: spec-driven\ncreated: 2026-07-01\nstarted_at: 2026-07-02T00:00:00Z\n",
        );
        fx.write("specseal/changes/started-c/tasks.md", "- [ ] 1.1 one\n- [ ] 1.2 two\n");
        fx.add_change("proposed-d", "schema: spec-driven\ncreated: 2026-07-01\n");
        fx.write("specseal/changes/proposed-d/tasks.md", "- [ ] 1.1 one\n");
        fx.write(
            "specseal/discussions/alpha-concluded.md",
            &discussion_doc("alpha-concluded", "Alpha", "concluded", ""),
        );
        fx.write(
            "specseal/discussions/beta-open.md",
            &discussion_doc("beta-open", "Beta", "open", ""),
        );
        fx.write(
            "specseal/discussions/gamma-promoted.md",
            &discussion_doc("gamma-promoted", "Gamma", "promoted", "promoted_to: cut-a\n"),
        );
        let stats = project_stats_at(fx.root()).expect("stats ok");
        assert_eq!(stats["pendingWrapUp"], 3, "ready-a + ready-b + alpha-concluded: {stats}");
        assert!(
            stats.get("inProgressChanges").is_none(),
            "inProgressChanges removed (design D6): {stats}"
        );
    }

    #[test]
    fn project_stats_pending_wrap_up_is_zero_when_nothing_awaits_the_user() {
        // 全部收尾后归零（Implementation Contract）：只剩进行中／proposed 与 open 讨论。
        let fx = FixtureRoot::new("stats-wrapup-zero");
        mark_adopted(&fx);
        fx.add_change("proposed-a", "schema: spec-driven\ncreated: 2026-07-01\n");
        fx.write("specseal/changes/proposed-a/tasks.md", "- [ ] 1.1 one\n");
        fx.write(
            "specseal/discussions/beta-open.md",
            &discussion_doc("beta-open", "Beta", "open", ""),
        );
        let stats = project_stats_at(fx.root()).expect("stats ok");
        assert_eq!(stats["pendingWrapUp"], 0, "{stats}");
    }

    #[test]
    fn project_stats_missing_path_is_an_error() {
        let fx = FixtureRoot::new("stats-missing");
        assert!(project_stats_at(&fx.root().join("gone")).is_err());
    }

    #[test]
    fn project_stats_rejects_a_root_that_stopped_being_a_project() {
        // 分页记录的 root 其规格文件夹已删但目录还在：探索会向上命中祖先
        // 项目——stats 必须拒绝（Err），不得回报别的项目的数字。
        let fx = FixtureRoot::new("stats-stale");
        let stale = fx.root().join("was-a-project");
        std::fs::create_dir_all(&stale).unwrap();
        assert!(project_stats_at(&stale).is_err());
        // 非项目的独立目录同样是 Err（uninitialized 不是可统计状态）。
        let plain = PlainDir::new("stats-plain");
        assert!(project_stats_at(plain.path()).is_err());
    }

    #[test]
    fn init_project_at_unknown_tool_is_rejected_with_zero_writes() {
        // 注入非法工具名被拒，且拒绝发生在任何写入之前。
        let plain = PlainDir::new("init-badtool");
        let before = entries(plain.path());
        let err = init_project_at(plain.path(), &["claude".into(), "vscode".into()])
            .expect_err("must fail");
        assert!(err.contains("vscode"), "must name the offender: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert_eq!(entries(plain.path()), before, "no writes on rejection");
    }

    // --- adopt_project_at：确认后补齐激活的文件效果（决策 2 消费；design 验收） ---

    #[test]
    fn adopt_project_at_imports_openspec_and_reports_project() {
        // 调用 core adopt 后重跑探测回报 Project；openspec/ 改名为 specseal/、既有文档内容不变
        // （spec Scenario「OpenSpec 项目确认激活后导入并切入」）。
        let fx = FixtureRoot::legacy("adopt-fill");
        fx.write("openspec/specs/auth/spec.md", "## Purpose\n既有规格。\n");
        let probe = adopt_project_at(fx.root(), &["claude".into()]).expect("adopt ok");
        match probe {
            ProjectProbe::Project { root, .. } => {
                assert_eq!(root, fx.root().display().to_string());
            }
            other => panic!("expected Project after adopt, got {other:?}"),
        }
        let p = fx.root();
        assert!(read(&p.join(".specseal.yaml")).contains("claude"));
        assert!(!p.join("CLAUDE.md").exists(), "工作区补齐不得产生指令档");
        assert!(p.join(".claude").join("skills").is_dir());
        assert!(!p.join("openspec").exists());
        assert_eq!(
            read(&p.join("specseal").join("specs").join("auth").join("spec.md")),
            "## Purpose\n既有规格。\n"
        );
    }

    #[test]
    fn adopt_project_at_refuses_an_uncommitted_openspec_with_a_single_line() {
        // spec Scenario「有未提交修改时激活失败」：单行错误说明原因，文件夹不变。
        let fx = FixtureRoot::legacy("adopt-dirty");
        fx.write("openspec/specs/auth/spec.md", "## Purpose\n既有规格。\n");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.test"])
                .args(args)
                .current_dir(fx.root())
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["add", "-A"]);
        git(&["commit", "-qm", "seed"]);
        fx.write("openspec/specs/auth/spec.md", "## Purpose\n改到一半。\n");

        let err = adopt_project_at(fx.root(), &["claude".into()]).expect_err("must fail");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert!(err.contains("openspec/ has uncommitted changes"), "{err}");
        assert!(fx.root().join("openspec").is_dir() && !fx.root().join("specseal").exists());
        assert!(!fx.root().join(".specseal.yaml").exists());
    }

    #[test]
    fn adopt_project_at_with_copilot_only_adds_github_skills() {
        // spec Scenario「激活时勾选 copilot」。
        let fx = FixtureRoot::legacy("adopt-copilot");
        fx.write("openspec/specs/auth/spec.md", "## Purpose\n既有规格。\n");
        adopt_project_at(fx.root(), &["copilot".into()]).expect("adopt ok");
        let p = fx.root();
        assert!(read(&p.join(".specseal.yaml")).contains("copilot"));
        assert!(p
            .join(".github")
            .join("skills")
            .join("specseal-propose")
            .join("SKILL.md")
            .is_file());
        for absent in ["CLAUDE.md", "AGENTS.md", ".claude", ".agents"] {
            assert!(!p.join(absent).exists(), "{absent} 不得生成");
        }
        assert_eq!(
            read(
                &p.join("specseal")
                    .join("specs")
                    .join("auth")
                    .join("spec.md")
            ),
            "## Purpose\n既有规格。\n"
        );
    }

    #[test]
    fn init_project_at_with_claude_pi_and_cursor_adds_three_skill_sets() {
        // spec Scenario「勾选 pi 与 cursor 时生成对应工具档」。
        let plain = PlainDir::new("init-claude-pi-cursor");
        init_project_at(plain.path(), &["claude".into(), "pi".into(), "cursor".into()]).expect("init ok");
        let p = plain.path();
        for skills in [".claude", ".pi", ".cursor"] {
            let propose = p.join(skills).join("skills").join("specseal-propose");
            assert!(propose.join("SKILL.md").is_file(), "{skills} 技能须生成");
        }
        for absent in [".cursor/agents", ".cursor/rules", "AGENTS.md"] {
            assert!(!p.join(absent).exists(), "{absent} 不得生成");
        }
        let app = read(&p.join(".specseal.yaml"));
        assert!(app.contains("tools: [claude, pi, cursor]"), "tools 依 claude、pi、cursor 记录: {app}");
    }

    #[test]
    fn adopt_project_at_with_cursor_only_keeps_the_existing_cursor_rules() {
        // spec Scenario「激活时勾选 cursor」：.cursor/rules/ 下既有文件比特级不变。
        let fx = FixtureRoot::legacy("adopt-cursor");
        fx.write("openspec/specs/auth/spec.md", "## Purpose\n既有规格。\n");
        fx.write(".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\n");
        adopt_project_at(fx.root(), &["cursor".into()]).expect("adopt ok");
        let p = fx.root();
        assert!(read(&p.join(".specseal.yaml")).contains("cursor"));
        assert!(p
            .join(".cursor")
            .join("skills")
            .join("specseal-propose")
            .join("SKILL.md")
            .is_file());
        assert_eq!(
            read(&p.join(".cursor").join("rules").join("style.mdc")),
            "---\nalwaysApply: true\n---\n"
        );
        for absent in ["CLAUDE.md", "AGENTS.md", ".claude", ".agents"] {
            assert!(!p.join(absent).exists(), "{absent} 不得生成");
        }
    }

    #[test]
    fn adopt_project_at_unknown_tool_is_rejected_with_zero_writes() {
        let fx = FixtureRoot::new("adopt-badtool");
        let before = entries(fx.root());
        let err = adopt_project_at(fx.root(), &["claude".into(), "vscode".into()])
            .expect_err("must fail");
        assert!(err.contains("vscode"), "must name the offender: {err}");
        assert!(!err.contains('\n'), "single line: {err:?}");
        assert_eq!(entries(fx.root()), before, "no writes on rejection");
    }
}
