"""Homograph Defender のアイコン(16/32/48/128)を描く。実行: python3 tools/make-icons.py(Pillow が必要。フォントは環境変数 ICON_FONT で変えられる)

紺の盾に白い「A」、その下に赤い帯(=1文字だけ赤く目立たせる拡張、の意味)。
状態(安全/危険)はアイコンではなくバッジで出すので、アイコン自体は落ち着いた色にする。
"""
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
FONT = os.environ.get("ICON_FONT", "/System/Library/Fonts/Supplemental/Arial Bold.ttf")
SCALE = 8  # 大きく描いて縮め、縁をなめらかにする


def shield(size):
    s = size
    # 上辺がやや丸い盾。下は尖らせる
    return [
        (0.50 * s, 0.04 * s), (0.88 * s, 0.16 * s), (0.88 * s, 0.50 * s),
        (0.80 * s, 0.70 * s), (0.66 * s, 0.85 * s), (0.50 * s, 0.96 * s),
        (0.34 * s, 0.85 * s), (0.20 * s, 0.70 * s), (0.12 * s, 0.50 * s),
        (0.12 * s, 0.16 * s),
    ]


def draw(px):
    big = px * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon(shield(big), fill=(30, 41, 59, 255))
    font = ImageFont.truetype(FONT, int(big * 0.50))
    box = d.textbbox((0, 0), "A", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((big - w) / 2 - box[0], big * 0.18 - box[1]), "A", font=font, fill=(255, 255, 255, 255))
    bar_w, bar_h = big * 0.40, max(big * 0.085, SCALE * 2)
    top = big * 0.72
    d.rounded_rectangle([(big - bar_w) / 2, top, (big + bar_w) / 2, top + bar_h], radius=bar_h / 2, fill=(229, 57, 53, 255))
    return img.resize((px, px), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for px in (16, 32, 48, 128):
    draw(px).save(OUT / f"icon{px}.png")
    print("saved", OUT / f"icon{px}.png")
