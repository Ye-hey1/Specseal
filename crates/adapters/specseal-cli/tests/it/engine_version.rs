//! `specseal --version` 的引擎版号查找面（spec「引擎版号查找面」）。
//!
//! 「这颗 binary 的引擎是哪版」以前无从问起——过期的 app 就这样装了进来。
//! 版号输出把它变成一条指令可断言，本机安装脚本的两道断言也创建在这上面。

use specseal_core::init::ASSET_VERSION;
use std::process::Command;

/// Scenario「--version 含引擎版号」＋ Example「版号输出格式」。
#[test]
fn version_prints_the_package_arch_and_engine_version_on_one_line() {
    let out = Command::new(env!("CARGO_BIN_EXE_specseal"))
        .arg("--version")
        .output()
        .expect("run specseal binary");

    assert!(out.status.success(), "--version must exit 0");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    assert_eq!(
        stdout.trim_end().lines().count(),
        1,
        "stdout must be a single line: {stdout}"
    );
    assert!(
        stdout.contains(env!("CARGO_PKG_VERSION")),
        "must carry the package version: {stdout}"
    );
    assert!(
        stdout.contains(&format!("engine {ASSET_VERSION}")),
        "must carry the artifact-layer version: {stdout}"
    );

    // Example「版号输出格式」：`<套件版号> (<架构>, engine <产物层版号>)`。
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        let arch = if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" };
        assert_eq!(
            stdout.trim_end(),
            format!(
                "specseal {} ({arch}, engine {ASSET_VERSION})",
                env!("CARGO_PKG_VERSION")
            ),
            "版号格式是对外契约"
        );
    }
}
