# Specseal 品牌资产

**繁体中文** · [English](README.en.md)

正式标志采「接合 S」：两段形状在中央接合，代表需求、规格与实作之间的链接。App 图标使用青绿圆角底板与白色 S，底板外侧透明；Windows 的圆角直接存在图档内，不依赖系统遮罩。

## 配色

| 角色 | 色值 | 用途 |
| --- | --- | --- |
| 青绿 | `#167873` | 标记、App 底板、`link` 字样 |
| 深灰 | `#292c32` | 浅色背景的 `Spec` 字样 |
| 浅灰白 | `#f5f5f5` | 深色背景的 `Spec` 字样 |
| 浅青绿 | `#4bb9b3` | 深色背景的标记与 `link` 字样 |

品牌固定色值与接口 theme token 分开管理；接口主色仍以 `packages/ui/src/theme.css` 为准。

## 文档

`svg/` 是可编辑的矢量原稿，文本已转成路径，不需安装字体。`transparent/` 是透明 PNG；本目录的同名 PNG 为白底（`-dark` 为深色底）版本。

| 文档名（省略扩展名） | 内容 |
| --- | --- |
| `specseal-app-icon` | 圆角底板＋白色 S，供 App／favicon 使用 |
| `specseal-logo-mark` | 青绿 S，无底板、无文本 |
| `specseal-wordmark` | 纯文本 `Specseal`，Spec 深灰、link 青绿 |
| `specseal-wordmark-dark` | 深色背景用纯文本版 |
| `specseal-logo-horizontal` | S＋字样的横式组合 |
| `specseal-logo-horizontal-dark` | 深色背景用横式组合 |
| `specseal-logo-vertical` | S 在上、字样在下 |
| `specseal-logo-system-sheet` | 全套组合与缩小尺寸一览（展示板有背景） |

## App 使用位置

- 接口（Desktop 与 Server Web 共用）：`packages/ui/src/assets/` 的三个 SVG——`logo-mark.svg`（裸标记，由 `specseal-logo-mark.svg` 拷贝并把填色改成 `currentColor`）、`logo-horizontal.svg` 与 `logo-horizontal-dark.svg`（逐字拷贝）；由 `packages/ui/src/components/Brand.tsx` 的 `BrandMark`（标记跟主色走）与 `Wordmark`（横式锁版，深色偏好取深色版）渲染。换 Logo 只换这三个档。
- Desktop favicon：`apps/desktop/public/logo-mark.png`（`index.html` 引用）。
- 原生 App：`apps/desktop/src-tauri/icons/`，包含 Windows `.ico`、macOS `.icns` 与各尺寸 PNG。
- 系统匣：18／36 px 单色 S（无底板），macOS 以 alpha 作为系统 template；36 px 版本同时内嵌于 `apps/desktop/src/trayIcon.ts`。

重新产生原生图标：

```sh
npx tauri icon docs/assets/brand/transparent/specseal-app-icon.png -o /tmp/specseal-icons
```

只将输出目录顶层的桌面图标拷贝到 `apps/desktop/src-tauri/icons/`；不收录自动产生的 iOS／Android 资产。系统匣使用独立的单色图档，更新后需同步其 base64 常数。
