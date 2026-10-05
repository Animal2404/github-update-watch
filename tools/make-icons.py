"""生成应用图标（构建资源，不是编译 App）。

  python tools/make-icons.py

产出：
  android/app/src/main/res/mipmap-*/ic_launcher.png (+ round)
  build/icon.png（512，Electron 用）与 build/icon.ico（Windows 安装包用）
图形：深色圆角底 + 绿色「下载更新」箭头，和界面主色一致（#22C55E on #0F172A）。
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (15, 23, 42, 255)
GREEN = (34, 197, 94, 255)


def draw_icon(size, round_icon=False):
    ss = 4  # 超采样，边缘更干净
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(s * 0.055)
    radius = int(s * 0.22)
    if round_icon:
        d.ellipse([pad, pad, s - pad, s - pad], fill=BG)
    else:
        d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=radius, fill=BG)

    # 向下箭头 + 底座
    cx = s / 2
    stem_w = s * 0.115
    stem_top = s * 0.24
    stem_bottom = s * 0.50
    d.rounded_rectangle(
        [cx - stem_w / 2, stem_top, cx + stem_w / 2, stem_bottom],
        radius=int(stem_w / 2), fill=GREEN,
    )
    head_w = s * 0.34
    head_top = s * 0.46
    head_bottom = s * 0.70
    d.polygon([(cx - head_w / 2, head_top), (cx + head_w / 2, head_top), (cx, head_bottom)], fill=GREEN)
    base_w = s * 0.44
    base_h = s * 0.085
    base_top = s * 0.775
    d.rounded_rectangle(
        [cx - base_w / 2, base_top, cx + base_w / 2, base_top + base_h],
        radius=int(base_h / 2), fill=GREEN,
    )
    return img.resize((size, size), Image.LANCZOS)


DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for name, px in DENSITIES.items():
    out_dir = os.path.join(ROOT, "android", "app", "src", "main", "res", f"mipmap-{name}")
    os.makedirs(out_dir, exist_ok=True)
    draw_icon(px).save(os.path.join(out_dir, "ic_launcher.png"))
    draw_icon(px, round_icon=True).save(os.path.join(out_dir, "ic_launcher_round.png"))
    print(f"mipmap-{name}: {px}px")

build_dir = os.path.join(ROOT, "build")
os.makedirs(build_dir, exist_ok=True)
icon512 = draw_icon(512)
icon512.save(os.path.join(build_dir, "icon.png"))
icon512.save(os.path.join(build_dir, "icon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("build/icon.png, build/icon.ico")
