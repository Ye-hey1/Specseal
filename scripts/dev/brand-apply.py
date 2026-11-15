#!/usr/bin/env python3
"""落地 Specseal 品牌资产（一次性迁移脚本）：裁边清理 → 派生 tauri 图标全套 → 品牌目录映射。
源图为 magpie 生成并已人工验收，路径全部硬编码。"""
import os
import subprocess

REPO = "/Users/mac/Desktop/Specseal"
SRC = "/tmp/brand-src"
ICON_SRC = SRC + "/app-icon.png"
MARK_SRC = SRC + "/logo-mark.png"
HORIZ_SRC = SRC + "/logo-horizontal.png"
HORIZ_DARK = SRC + "/logo-horizontal-dark.png"
WORD_SRC = SRC + "/wordmark.png"
BRAND = REPO + "/docs/assets/brand"
TR = BRAND + "/transparent"
TAURI = REPO + "/apps/desktop/src-tauri/icons"

def sips(width, height, src, dst):
    subprocess.run(["/usr/bin/sips", "-z", str(width), str(height), src, "--out", dst], check=True)

# 1) app icon：裁掉边缘 3%（去生成伪影）后作为 1024 母版
clean = SRC + "/app-icon-clean.png"
subprocess.run(
    ["/usr/bin/sips", "--cropToHeightWidth", "960", "960", "--cropOffset", "32", "32", ICON_SRC, "--out", clean],
    check=True,
)

# tauri 图标全套
icon_targets = [
    (1024, "icon.png"),
    (32, "32x32.png"),
    (64, "64x64.png"),
    (128, "128x128.png"),
    (256, "128x128@2x.png"),
    (44, "Square44x44Logo.png"),
    (71, "Square71x71Logo.png"),
    (89, "Square89x89Logo.png"),
    (107, "Square107x107Logo.png"),
    (142, "Square142x142Logo.png"),
    (150, "Square150x150Logo.png"),
    (284, "Square284x284Logo.png"),
    (310, "Square310x310Logo.png"),
    (50, "StoreLogo.png"),
]
for width, name in icon_targets:
    sips(width, width, clean, TAURI + "/" + name)

# icns：iconset + iconutil
iconset = SRC + "/specseal.iconset"
os.makedirs(iconset, exist_ok=True)
icns_sizes = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"), (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"), (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"), (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]
for width, name in icns_sizes:
    sips(width, width, clean, iconset + "/" + name)
subprocess.run(["/usr/bin/iconutil", "-c", "icns", iconset, "-o", TAURI + "/icon.icns"], check=True)

# Windows ico：sips 不能产 ico，先以同名 png 伴随（tauri icon 在 CI 重新生成正式 ico）
sips(256, 256, clean, TAURI + "/icon.ico.png")

# 2) 品牌目录映射
sips(1024, 1024, clean, BRAND + "/specseal-app-icon.png")
sips(1024, 1024, MARK_SRC, BRAND + "/specseal-logo-mark.png")
sips(1536, 640, HORIZ_SRC, BRAND + "/specseal-logo-horizontal.png")
sips(1536, 640, HORIZ_DARK, BRAND + "/specseal-logo-horizontal-dark.png")
sips(1024, 512, WORD_SRC, BRAND + "/specseal-wordmark.png")
sips(1024, 1024, MARK_SRC, TR + "/specseal-logo-mark.png")
sips(1536, 640, HORIZ_SRC, TR + "/specseal-logo-horizontal.png")
sips(1536, 640, HORIZ_DARK, TR + "/specseal-logo-horizontal-dark.png")
sips(1024, 512, WORD_SRC, TR + "/specseal-wordmark.png")
# vertical 与 system-sheet 先以现有资源占位（竖版组合待正式设计稿）
sips(1024, 1024, MARK_SRC, BRAND + "/specseal-logo-vertical.png")
sips(1536, 640, HORIZ_SRC, BRAND + "/specseal-logo-system-sheet.png")
sips(1024, 512, WORD_SRC, BRAND + "/specseal-wordmark-dark.png")

# 3) tray 图标（透明底 mark 缩放）
sips(18, 18, MARK_SRC, TAURI + "/specseal-tray-18.png")
sips(36, 36, MARK_SRC, TAURI + "/specseal-tray-18@2x.png")

print("brand assets applied")
