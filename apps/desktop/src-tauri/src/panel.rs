//! 系统匣面板（tray-status-menu「面板样式」）：lazy 创建 tray-panel webview 窗口，
//! 对外只露出 `toggle` 与 `hide`，各平台的窗口实作分在各自的区块（tray-panel-windows
//! design D6）。创建失败、macOS 定位失败或 Windows 显示失败时回单行 Err——前端据此退回
//! 原生菜单样式并于设置页浮出；Windows 的收起与定位失败不回错。
//!
//! - macOS（design D5）：转为 nonactivating NSPanel——打开不夺前景 app 焦点、失焦
//!   （resign key）自动收合；window-vibrancy 套 HudWindow 材质、positioner 以 tray
//!   相对位置贴齐图标下方（座标由前端 handleIconState 喂入）。
//! - Windows（tray-panel-windows design D1／D3／D4）：不透明、无外框、带系统阴影的
//!   一般窗口；依系统匣图标位置在其屏幕的 work area 内定位、大小改变就重新定位；
//!   打开取得焦点、失焦收起，收起后的短暂窗口内忽略打开要求。
//! - Linux：不提供面板（系统匣恒为原生菜单样式），toggle 回 Err 作守门、hide 无事。

#[cfg(target_os = "macos")]
pub use macos::{hide, toggle};
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use unsupported::{hide, toggle};
#[cfg(target_os = "windows")]
pub use windows::{hide, toggle};

/// 两平台共用的面板窗口设置（D6）：标签与 builder 的共同前段——无外框、不可调整大小、
/// 不进任务栏、置顶、先隐藏；各平台再叠上自己的外观设置。
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod common {
    use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder, Wry};

    pub const PANEL_LABEL: &str = "tray-panel";
    const PANEL_WIDTH: f64 = 320.0;
    const PANEL_HEIGHT: f64 = 420.0;

    pub fn builder(app: &AppHandle) -> WebviewWindowBuilder<'_, Wry, AppHandle> {
        WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("panel.html".into()))
            .title("Specseal")
            .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible(false)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use tauri::{AppHandle, Manager};
    use tauri_nspanel::{tauri_panel, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};
    use tauri_plugin_positioner::{Position, WindowExt};
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    use super::common::{builder, PANEL_LABEL};

    tauri_panel! {
        // 可成 key（面板内可交互、失焦可侦测）但不可成 main、不 activate app。
        panel!(TrayStatusPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })

        panel_event!(TrayStatusPanelEvents {
            window_did_resign_key(notification: &NSNotification) -> ()
        })
    }

    /// 点击系统匣图标的开闭入口：不存在则 lazy 创建，存在则 toggle 显隐。
    /// 显示前依 positioner 的 tray 座标贴齐图标下方。
    pub fn toggle(app: &AppHandle) -> Result<(), String> {
        if app.get_webview_panel(PANEL_LABEL).is_err() {
            create(app)?;
        }
        let panel = app
            .get_webview_panel(PANEL_LABEL)
            .map_err(|_| "tray panel unavailable after creation".to_string())?;
        if panel.is_visible() {
            panel.hide();
            return Ok(());
        }
        if let Some(window) = app.get_webview_window(PANEL_LABEL) {
            window
                .move_window(Position::TrayBottomCenter)
                .map_err(|e| format!("tray panel positioning failed: {e}"))?;
        }
        // nonactivating panel：不 activate app、不把主窗口拉前景；成为 key 才收得到
        // resign key（失焦自动收合的触发源）——Spotlight 式面板的标准姿势。
        panel.show_and_make_key();
        Ok(())
    }

    /// 面板收合入口——交接主窗口前（tray-status-menu「面板交接主窗口后鼠标交互完整」；
    /// design D2）与失焦自动收合共用。幂等且不会失败：面板尚未创建或已收合皆无事，
    /// 不像 toggle 会把已收合的面板重新打开；hide 即 orderOut，对已隐藏的窗口本身就是无事。
    pub fn hide(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel(PANEL_LABEL) {
            panel.hide();
        }
    }

    /// 创建面板窗口：共用前段（无边框、不进任务栏、置顶、先隐藏）加透明；转 NSPanel 后套
    /// nonactivating style mask、浮动层级、vibrancy HudWindow 材质与失焦收合。
    fn create(app: &AppHandle) -> Result<(), String> {
        let window = builder(app)
            .transparent(true)
            .focused(false)
            // 全透明背景色不可省：wry 仅在明给 background_color 时才清 WKWebView 的
            // underPageBackgroundColor（macOS 12+ 缺省不透明浅灰）——只设 transparent
            // 会被这层盖住 vibrancy（实测为面板完全不透的根因）。
            .background_color(tauri::utils::config::Color(0, 0, 0, 0))
            .build()
            .map_err(|e| format!("tray panel window creation failed: {e}"))?;

        let panel = window
            .to_panel::<TrayStatusPanel>()
            .map_err(|e| format!("tray panel conversion failed: {e}"))?;
        panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
        panel.set_level(PanelLevel::Floating.value());
        panel.set_hides_on_deactivate(false);
        // vibrancy 前提：NSPanel 本身不透明会盖掉 NSVisualEffectView——类别交换后
        // 明确重设（builder 的 transparent 设置不保证存续到 panel 类别）。
        panel.set_opaque(false);
        panel.set_transparent(true);
        // 毛玻璃：于类别交换「之后」明确套用（builder 期套用不保证存续；menubar app
        // 的实证路径即 window-vibrancy 显式调用）。材质选 HudWindow——透感最强、
        // 背后内容经 blur 可辨（design D6：Menu 为真 NSMenu 材质但浅色模式近乎
        // 不透、不满足「毛玻璃底可透出」，Popover 更不透——实测裁决换用）。
        apply_vibrancy(
            &window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(13.0),
        )
        .map_err(|e| format!("tray panel vibrancy failed: {e}"))?;

        // 失焦自动收合（spec：点面板外任意处面板收合）。
        let handler = TrayStatusPanelEvents::new();
        let handle = app.clone();
        handler.window_did_resign_key(move |_notification| hide(&handle));
        panel.set_event_handler(Some(handler.as_ref()));
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::sync::Mutex;
    use std::time::Instant;

    use specseal_desktop_core::tray_panel::{panel_position, should_ignore_open, PxRect};
    use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

    use super::common::{builder, PANEL_LABEL};

    /// 系统匣图标的 id——与 apps/desktop/src/tray.ts 创建图标时的 id 一致。
    const TRAY_ID: &str = "specseal-tray";

    /// 面板状态（D3／D4），随面板创建以 app.manage 注册。icon 是打开当下的图标位置，
    /// 供大小改变时重新定位：图标在溢出区（^）时，溢出窗口收起后就查不到原本的位置。
    #[derive(Default)]
    struct PanelState {
        last_hidden: Mutex<Option<Instant>>,
        icon: Mutex<Option<PxRect>>,
    }

    /// 点击系统匣图标（左键）的开闭入口：不存在则 lazy 创建，存在则 toggle 显隐。
    /// 打开要求落在失焦收起后的抑制窗口内即忽略——那次失焦正是这次点击图标造成的。
    /// 只有创建与显示失败回 Err；收起与定位失败不退回原生菜单（面板仍可用）。
    pub fn toggle(app: &AppHandle) -> Result<(), String> {
        let window = match app.get_webview_window(PANEL_LABEL) {
            Some(window) => window,
            None => create(app)?,
        };
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return Ok(());
        }
        let state = app.state::<PanelState>();
        if should_ignore_open(*state.last_hidden.lock().unwrap(), Instant::now()) {
            return Ok(());
        }
        let icon = icon_rect(app);
        *state.icon.lock().unwrap() = icon;
        place(&window, icon);
        window
            .show()
            .map_err(|e| format!("tray panel show failed: {e}"))?;
        // 取得焦点才收得到失焦（点面板外收起的触发源）；取不到时面板仍可经点图标关闭，
        // 不为此退回原生菜单。
        let _ = window.set_focus();
        Ok(())
    }

    /// 面板收合入口——交接主窗口前调用。幂等且不会失败：面板尚未创建或已收合皆无事。
    pub fn hide(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(PANEL_LABEL) {
            let _ = window.hide();
        }
    }

    /// 创建面板窗口（D1）：共用前段加系统阴影（Windows 11 由系统画圆角）、不透明
    /// （builder 缺省）；挂上大小改变重新定位与失焦收起，并随主窗口关闭而关闭。
    fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
        app.manage(PanelState::default());
        let window = builder(app)
            .shadow(true)
            .build()
            .map_err(|e| format!("tray panel window creation failed: {e}"))?;
        let handle = window.clone();
        window.on_window_event(move |event| match event {
            // 前端随内容 setSize：重做定位，贴齐任务栏的那一边维持贴齐（D3）。
            WindowEvent::Resized(_) if handle.is_visible().unwrap_or(false) => {
                place(&handle, *handle.state::<PanelState>().icon.lock().unwrap());
            }
            WindowEvent::Focused(false) => {
                let _ = handle.hide();
                *handle.state::<PanelState>().last_hidden.lock().unwrap() = Some(Instant::now());
            }
            _ => {}
        });
        // Tauri 在所有窗口都关闭后才结束 app：常驻隐藏的面板会让主窗口关闭后行程不结束，
        // 故主窗口关闭时一并关闭面板——与加入面板前「关主窗口即结束」一致。
        if let Some(main) = app.get_webview_window("main") {
            let panel = window.clone();
            main.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    let _ = panel.destroy();
                }
            });
        }
        Ok(window)
    }

    /// 系统匣图标的实体像素位置；图标不存在或系统不提供时为 None。
    fn icon_rect(app: &AppHandle) -> Option<PxRect> {
        let rect = app.tray_by_id(TRAY_ID)?.rect().ok()??;
        // 系统匣回报的图标位置即实体像素，缩放倍率不影响换算。
        let position = rect.position.to_physical::<i32>(1.0);
        let size = rect.size.to_physical::<u32>(1.0);
        Some(PxRect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    }

    /// 定位（D3）：取图标所在屏幕的 work area，交 panel_position 算出位置——水平以图标
    /// 为中心并限制在范围内、垂直贴齐任务栏那一侧。图标位置、屏幕或窗口大小取不到时
    /// 不移动（停在原位），不为定位失败退回原生菜单。
    fn place(window: &WebviewWindow, icon: Option<PxRect>) {
        let Some(icon) = icon else { return };
        let center_x = icon.x as f64 + icon.width as f64 / 2.0;
        let center_y = icon.y as f64 + icon.height as f64 / 2.0;
        let (Ok(Some(monitor)), Ok(size)) = (
            window.monitor_from_point(center_x, center_y),
            window.outer_size(),
        ) else {
            return;
        };
        let area = monitor.work_area();
        let (x, y) = panel_position(
            icon,
            size.width,
            size.height,
            PxRect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            },
        );
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported {
    use tauri::AppHandle;

    pub fn toggle(_app: &AppHandle) -> Result<(), String> {
        Err("tray panel is unavailable on this platform".to_string())
    }

    pub fn hide(_app: &AppHandle) {}
}
