#!/usr/bin/env python3
"""生成 DSH 桌面版需要的应用图标。

思路：
  - 应用图标 = 圆角方块（DeepSeek 品牌蓝 #4D6BFE）+ 居中的白色 dsh logo，
    这样在浅色/深色主题的任务栏和启动器里都清晰可辨。

（第二版去掉了系统托盘，所以这里不再产出 tray.png；关窗口就是退出程序。）

logo 直接复用 dsh 官方前端里的 favicon-dark.svg（白色描边版本），保证图形与大厂一致。
依赖：cairosvg（SVG 栅格化）、Pillow（圆角矩形与缩放）。
"""

from __future__ import annotations

import io
import pathlib
import sys

try:
    import cairosvg
except ImportError:  # pragma: no cover - 环境缺依赖时给出可执行的提示
    sys.exit("缺少 cairosvg，请先执行：pip3 install cairosvg")
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
LOGO_SVG = ASSETS / "favicon-dark.svg"  # 白色 logo

# 需要产出的应用图标尺寸（覆盖 GNOME / 文件管理器 / 任务栏常见取值）
APP_ICON_SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
# 品牌蓝，取自 DeepSeek 官网主色
BRAND_COLOR = (77, 107, 254, 255)
# 渲染 SVG 时的超采样分辨率，先大后小能保住细节
RENDER_SIZE = 1024


def render_logo(size: int = RENDER_SIZE) -> Image.Image:
    """把白色 dsh logo 渲染成指定边长的 RGBA 图片。"""
    png_bytes = cairosvg.svg2png(url=str(LOGO_SVG), output_width=size, output_height=size)
    return Image.open(io.BytesIO(png_bytes)).convert("RGBA")


def make_app_icon(logo: Image.Image, size: int) -> Image.Image:
    """合成应用图标：品牌蓝圆角底 + 居中白色 logo。

    参数：
        logo: 高分辨率的白色 logo 图片。
        size: 目标边长（像素）。
    返回：
        指定边长的 RGBA 图标。
    """
    canvas = Image.new("RGBA", (RENDER_SIZE, RENDER_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    # 圆角半径取边长的 22%，接近 GNOME 原生图标的圆角观感
    draw.rounded_rectangle(
        (0, 0, RENDER_SIZE - 1, RENDER_SIZE - 1),
        radius=int(RENDER_SIZE * 0.22),
        fill=BRAND_COLOR,
    )
    # logo 占画布 62%，四周留出呼吸空间
    inner = int(RENDER_SIZE * 0.62)
    logo_scaled = logo.resize((inner, inner), Image.LANCZOS)
    offset = (RENDER_SIZE - inner) // 2
    canvas.alpha_composite(logo_scaled, (offset, offset))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    """产出 assets/icon.png、assets/icon-256.png 以及 hicolor 各尺寸图标。"""
    if not LOGO_SVG.exists():
        sys.exit(f"找不到 logo 文件：{LOGO_SVG}")
    ASSETS.mkdir(parents=True, exist_ok=True)
    logo = render_logo()

    icons_dir = ASSETS / "icons" / "hicolor"
    for size in APP_ICON_SIZES:
        icon = make_app_icon(logo, size)
        target_dir = icons_dir / f"{size}x{size}" / "apps"
        target_dir.mkdir(parents=True, exist_ok=True)
        icon.save(target_dir / "dsh-desktop.png")
    # 窗口图标与 Electron 默认取用的那份
    make_app_icon(logo, 512).save(ASSETS / "icon.png")
    make_app_icon(logo, 256).save(ASSETS / "icon-256.png")

    print(f"图标已生成：{ASSETS}/icon.png、{ASSETS}/icon-256.png，以及 hicolor 各尺寸目录")


if __name__ == "__main__":
    main()
