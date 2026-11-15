//! 项目层文件系统动作（design D5）：候选组装与依序启动在 specseal-desktop-core，
//! 这里只委派。「在文件管理员显示」沿用既有的 `reveal_in_folder`。
//!
//! PATH 取用户 login shell 的值：macOS 从 Dock 启动的 app 只有系统缺省 PATH，
//! 找不到 Homebrew 或 /usr/local/bin 下的 code 等指令。

use specseal_desktop_core::fs_actions::{editor_candidates, launch_first, terminal_candidates, Platform};

use crate::cli_install::user_shell_path;

#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = terminal_candidates(Platform::current(), &path);
        launch_first(&path, candidates, &user_shell_path(), "fs.noTerminal")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_in_editor(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = editor_candidates(Platform::current(), &path);
        launch_first(&path, candidates, &user_shell_path(), "fs.noEditor")
    })
    .await
    .map_err(|e| e.to_string())?
}
