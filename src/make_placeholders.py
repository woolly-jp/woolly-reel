#!/usr/bin/env python3
"""見本用の仮画像を2枚つくる(本物の写真が届くまでの代用)"""
import math
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SANS = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
out = sys.argv[1]
random.seed(7)


def label(img, text, fill):
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(SANS, 54, index=0)
    w = d.textlength(text, font=f)
    d.text(((img.width - w) / 2, img.height * 0.36), text, font=f, fill=fill)


# 着用イメージ(仮): やわらかい自然光の部屋のような色面
wear = Image.new("RGB", (1200, 2133), (226, 214, 198))
d = ImageDraw.Draw(wear)
for y in range(wear.height):
    k = y / wear.height
    d.line([(0, y), (wear.width, y)],
           fill=(int(236 - 34 * k), int(226 - 38 * k), int(212 - 44 * k)))
d.ellipse([-200, -300, 900, 800], fill=(248, 240, 226))
d.rounded_rectangle([260, 900, 940, 1900], radius=320, fill=(172, 158, 142))
d.rounded_rectangle([300, 1180, 900, 1560], radius=60, fill=(84, 82, 80))
wear = wear.filter(ImageFilter.GaussianBlur(26))
label(wear, "着用イメージ(仮)", (255, 252, 246))
wear.save(f"{out}/wear_placeholder.jpg", quality=92)

# 実物写真(仮): チャコールのリブ編みのような縞
prod = Image.new("RGB", (1200, 2133), (70, 68, 66))
d = ImageDraw.Draw(prod)
for x in range(0, prod.width, 2):
    v = 66 + int(16 * math.sin(x / 9.0)) + random.randint(-3, 3)
    d.line([(x, 0), (x, prod.height)], fill=(v + 2, v, v - 2), width=2)
prod = prod.filter(ImageFilter.GaussianBlur(1.2))
label(prod, "実物写真(仮)", (236, 230, 220))
prod.save(f"{out}/product_placeholder.jpg", quality=92)
print("仮画像を2枚つくりました")
