//! CLI 布署的壳层（desktop-app spec「安装 CLI 指令到 PATH」，design D5）：
//! 收集环境事实（平台、PATH、sidecar 路径、已布署版本输出）与运行布署计划
//! （symlink／copy）。状态判定与平台分流的决策归前端 core（vitest 覆盖），
//! 此处不做任何判断。

use std::path::PathBuf;
use std::process::Command;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallProbe {
    pub platform: String,
    pub home: Option<String>,
    pub path_env: String,
    pub path_delimiter: String,
    pub bundled_cli_path: Option<String>,
    pub app_version: String,
    pub deployed_version_output: Option<String>,
    /// ~/.zprofile 现有内容（macOS；读不到或非 macOS 为 None）——前端 core 的
    /// PATH 幂等追加判定输入（design D12）。
    pub zprofile: Option<String>,
}

fn platform_key() -> String {
    if cfg!(target_os = "macos") {
        "macos".into()
    } else if cfg!(target_os = "windows") {
        "windows".into()
    } else if std::env::var_os("APPIMAGE").is_some() {
        "linux-appimage".into()
    } else {
        // 非 AppImage 的 Linux 运行（开发建置或手动解开的 app）：deb 已退场
        // （release-assets-trim D7），没有套件管理器布署的 /usr/bin 可探。
        "linux-unpackaged".into()
    }
}

/// 随附 CLI 的位置：Tauri externalBin 布于主运行档同目录。
fn bundled_cli_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(target_os = "windows") { "specseal.exe" } else { "specseal" };
    let path = exe.parent()?.join(name);
    path.exists().then_some(path)
}

/// 已布署 CLI 的 `--version` 原始输出（解析归前端 core）；不存在／不可运行＝None。
fn deployed_version_output(platform: &str, home: Option<&str>) -> Option<String> {
    let program: PathBuf = match platform {
        "macos" | "linux-appimage" | "linux-unpackaged" => {
            PathBuf::from(home?).join(".local/bin/specseal")
        }
        // Windows 由安装器把 CLI 布于 app 同目录并写 PATH；刚装完时 PATH
        // broadcast 未及已运行进程，走进程 PATH 会误报未安装——直接以
        // sidecar 同目录（即 $INSTDIR）运行。
        _ => bundled_cli_path()?,
    };
    let output = Command::new(program).arg("--version").output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// PATH 提示的判定基准是「用户终端」的 PATH——macOS GUI app 从 Dock 启动
/// 不继承 shell 设置档，进程 PATH 只有系统缺省，直接用会误报「不在 PATH」。
/// 以 login shell 解析真实 PATH；失败（非 unix、shell 异常）退回进程 PATH。
pub(crate) fn user_shell_path() -> String {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        if let Ok(output) = Command::new(&shell).args(["-lc", r#"printf %s "$PATH""#]).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).into_owned();
                if !path.trim().is_empty() {
                    return path;
                }
            }
        }
    }
    std::env::var("PATH").unwrap_or_default()
}

pub fn probe(app_version: String) -> CliInstallProbe {
    let platform = platform_key();
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    let deployed_version_output = deployed_version_output(&platform, home.as_deref());
    let zprofile = (platform == "macos")
        .then(|| home.as_deref().map(|h| PathBuf::from(h).join(".zprofile")))
        .flatten()
        .map(|p| std::fs::read_to_string(p).unwrap_or_default());
    CliInstallProbe {
        platform,
        path_env: user_shell_path(),
        path_delimiter: if cfg!(target_os = "windows") { ";".into() } else { ":".into() },
        bundled_cli_path: bundled_cli_path().map(|p| p.to_string_lossy().into_owned()),
        app_version,
        deployed_version_output,
        zprofile,
        home,
    }
}

/// 追加一行至 ~/.zprofile（macOS PATH 自动设置；幂等判定归前端 core，此处只
/// 负责安全地写：保留既有内容、必要时补结尾换行）。
pub fn zprofile_append(line: &str) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "找不到 HOME 目录".to_string())?;
    let path = PathBuf::from(home).join(".zprofile");
    let mut content = std::fs::read_to_string(&path).unwrap_or_default();
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(line);
    content.push('\n');
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// 前端 core 产出的布署计划（「none」不会被送来——前端已挡）。
#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum CliDeployPlan {
    #[serde(rename = "symlink", rename_all = "camelCase")]
    Symlink { link_path: PathBuf, target_path: PathBuf },
    #[serde(rename = "copy", rename_all = "camelCase")]
    Copy { dest_path: PathBuf, source_path: PathBuf },
}

pub fn deploy(plan: CliDeployPlan) -> Result<(), String> {
    match plan {
        CliDeployPlan::Symlink { link_path, target_path } => {
            let parent = link_path.parent().ok_or("symlink 路径缺少父目录")?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            // 既有 symlink／文件先移除，重复安装与换目标皆幂等。
            if std::fs::symlink_metadata(&link_path).is_ok() {
                std::fs::remove_file(&link_path).map_err(|e| e.to_string())?;
            }
            #[cfg(unix)]
            return std::os::unix::fs::symlink(&target_path, &link_path).map_err(|e| e.to_string());
            #[cfg(not(unix))]
            {
                let _ = target_path;
                Err("此平台不支持 symlink 布署".into())
            }
        }
        CliDeployPlan::Copy { dest_path, source_path } => {
            let parent = dest_path.parent().ok_or("拷贝目的地缺少父目录")?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            std::fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dest_path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}
