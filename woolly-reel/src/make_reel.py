#!/usr/bin/env python3
"""Woolly リール動画メーカー(4テンプレート / 素材2枚 / 5.5秒)

テンプレート: slide(スライド型) / zoom(ゆっくりズーム型) /
              detail(ディテール型) / notice(告知型)

使い方:
    python3 make_reel.py 設定.json 出力.mp4

設定.json の例は sample_config.json を参照。
動きは「ゆっくりしたズーム」と「クロスフェード」だけ。凝った演出は入れない。
"""
import json
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H, FPS = 1080, 1920, 30

# ブランドの色(生成りとチャコール)
KINARI = (244, 239, 230)
CHARCOAL = (58, 56, 54)
SOFT_GRAY = (128, 122, 114)

SERIF = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"
SANS = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"


def font(path, size):
    return ImageFont.truetype(path, size, index=0)  # index 0 = 日本語(JP)


def ease(t):
    """ゆっくり始まり、ゆっくり終わる"""
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def cover(img, zoom):
    """画像を縦長の画面いっぱいに切り出す。zoom=1.0 でちょうど、1.06 で少し寄る"""
    iw, ih = img.size
    scale = max(W / iw, H / ih) * zoom
    cw, ch = W / scale, H / scale
    left, top = (iw - cw) / 2, (ih - ch) / 2
    return img.resize((W, H), Image.LANCZOS, box=(left, top, left + cw, top + ch))


def spaced(draw, xy, text, fnt, fill, spacing=0, anchor_center=True):
    """字間をあけて文字を描く"""
    widths = [draw.textlength(c, font=fnt) for c in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x, y = xy
    if anchor_center:
        x -= total / 2
    for c, w in zip(text, widths):
        draw.text((x, y), c, font=fnt, fill=fill)
        x += w + spacing
    return total


def fit_font(draw, text, path, size, max_width, spacing=0):
    """枠に収まるまで文字を小さくする"""
    while size > 24:
        f = font(path, size)
        width = sum(draw.textlength(c, font=f) for c in text) + spacing * (len(text) - 1)
        if width <= max_width:
            return f
        size -= 2
    return font(path, size)


VIDEO_EXT = (".mp4", ".mov", ".m4v", ".webm")


class Clip:
    """動画素材を1コマずつ読む(縦長に切り出し、音は使わない)"""

    def __init__(self, path):
        vf = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS}"
        self.proc = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-i", path, "-an", "-vf", vf,
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        self.last = None

    def next(self):
        buf = self.proc.stdout.read(W * H * 3)
        if len(buf) == W * H * 3:
            self.last = Image.frombytes("RGB", (W, H), buf)
        if self.last is None:
            sys.exit("動画素材を読めませんでした")
        return self.last  # 素材が短いときは最後のコマで止める


def load(scene, cfg):
    if scene.get("card"):
        return card(cfg)
    path = scene["image"]
    if path.lower().endswith(VIDEO_EXT):
        return Clip(path)
    return ImageOps.exif_transpose(Image.open(path)).convert("RGB")


def shade(layer, height=700, strength=110):
    """文字を読みやすくするため、下側だけうっすら暗くする"""
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    for i in range(height):
        a = int(strength * (i / height) ** 1.6)
        sd.line([(0, H - height + i), (W, H - height + i)], fill=(30, 28, 26, a))
    return Image.alpha_composite(layer, sh)


def ai_label(d):
    """明るい写真でも読めるよう、小さな半透明の札に入れる"""
    f = font(SANS, 26)
    label = "イメージ画像"
    tw = d.textlength(label, font=f)
    x0, y0 = W - tw - 84, 88
    d.rounded_rectangle([x0, y0, W - 40, y0 + 52], radius=26, fill=(40, 38, 36, 120))
    d.text((x0 + 22, y0 + 6), label, font=f, fill=(255, 255, 255, 240))


def overlay(scene, cfg):
    """1場面に重ねる文字の層をつくる"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    kind = scene.get("overlay")
    white = (255, 252, 246, 255)
    if kind == "copy":      # 大きめのひとこと
        layer = shade(layer)
        d = ImageDraw.Draw(layer)
        f = fit_font(d, scene["text"], SERIF, 68, W - 200, spacing=8)
        spaced(d, (W / 2, H - 470), scene["text"], f, white, spacing=8)
    elif kind == "caption":  # 小さめの商品名
        layer = shade(layer, 560, 120)
        d = ImageDraw.Draw(layer)
        spaced(d, (W / 2, H - 430), cfg.get("brand", "Woolly"), font(SANS, 28),
               (255, 252, 246, 215), spacing=14)
        f = fit_font(d, scene["text"], SERIF, 50, W - 200, spacing=4)
        spaced(d, (W / 2, H - 370), scene["text"], f, white, spacing=4)
    elif kind == "panel":    # 商品名・色・価格の帯
        d = ImageDraw.Draw(layer)
        top = H - 520
        d.rectangle([0, top, W, H], fill=KINARI + (255,))
        spaced(d, (W / 2, top + 62), cfg.get("brand", "Woolly"), font(SANS, 30),
               SOFT_GRAY + (255,), spacing=14)
        d.line([(W / 2 - 36, top + 124), (W / 2 + 36, top + 124)], fill=SOFT_GRAY + (255,), width=2)
        f = fit_font(d, cfg["name"], SERIF, 58, W - 160, spacing=4)
        spaced(d, (W / 2, top + 160), cfg["name"], f, CHARCOAL + (255,), spacing=4)
        y = top + 258
        if cfg.get("variant"):
            spaced(d, (W / 2, y), cfg["variant"], font(SANS, 34), SOFT_GRAY + (255,), spacing=6)
            y += 74
        if cfg.get("price"):
            spaced(d, (W / 2, y), cfg["price"], font(SERIF, 50), CHARCOAL + (255,), spacing=3)
    if scene.get("ai_label"):
        ai_label(ImageDraw.Draw(layer))
    return layer


def card(cfg):
    """告知型の、文字が主役の画面"""
    img = Image.new("RGB", (W, H), KINARI)
    d = ImageDraw.Draw(img)
    lines = cfg.get("notice_lines", [])
    block = 150 + 110 + 84 * len(lines)
    y = (H - block) / 2 - 40
    spaced(d, (W / 2, y), cfg.get("brand", "Woolly"), font(SANS, 32), SOFT_GRAY, spacing=14)
    d.line([(W / 2 - 36, y + 70), (W / 2 + 36, y + 70)], fill=SOFT_GRAY, width=2)
    title = cfg.get("notice_title", "")
    f = fit_font(d, title, SERIF, 84, W - 180, spacing=6)
    spaced(d, (W / 2, y + 130), title, f, CHARCOAL, spacing=6)
    yy = y + 290
    for line in lines:
        f = fit_font(d, line, SANS, 42, W - 200, spacing=3)
        spaced(d, (W / 2, yy), line, f, CHARCOAL, spacing=3)
        yy += 84
    return img


def scenes_for(cfg):
    """テンプレートごとの2場面の中身"""
    t = cfg.get("template", "slide")
    ai = cfg.get("ai_image", True)
    if t == "slide":
        return [{"image": cfg["wear_image"], "overlay": "copy", "text": cfg["copy"], "ai_label": ai},
                {"image": cfg["product_image"], "overlay": "panel"}]
    if t == "zoom":
        return [{"image": cfg["wear_image"], "overlay": "copy", "text": cfg["copy"], "ai_label": ai},
                {"image": cfg["product_image"], "overlay": "caption", "text": cfg["name"]}]
    if t == "detail":
        return [{"image": cfg["product_image"], "overlay": "caption", "text": cfg["name"]},
                {"image": cfg["detail_image"], "overlay": "copy", "text": cfg["copy"]}]
    if t == "notice":
        return [{"card": True},
                {"image": cfg["product_image"], "overlay": "caption", "text": cfg["name"]}]
    sys.exit(f"知らないテンプレートです: {t}")


def with_alpha(layer, alpha):
    if alpha >= 1:
        return layer
    out = layer.copy()
    out.putalpha(out.getchannel("A").point(lambda v: int(v * alpha)))
    return out


def render(cfg, out_path):
    hold = float(cfg.get("seconds_per_image", 2.75))  # 1枚あたりの秒数
    fade = float(cfg.get("crossfade", 0.6))            # 切り替えの秒数
    default_zoom = 0.10 if cfg.get("template") == "zoom" else 0.06
    zoom_amt = float(cfg.get("zoom", default_zoom))    # ズームの量(0.06 = 6%)
    total = hold * 2
    n = int(round(total * FPS))

    sc = scenes_for(cfg)
    imgs = [load(s, cfg) for s in sc]
    ovs = [overlay(s, cfg) for s in sc]

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
    ]
    if cfg.get("bgm"):
        cmd += ["-stream_loop", "-1", "-i", cfg["bgm"]]
        audio = ["-af", f"afade=t=in:d=0.4,afade=t=out:st={total - 0.6}:d=0.6"]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        audio = []
    cmd += [
        "-map", "0:v", "-map", "1:a", "-t", f"{total}",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
        "-profile:v", "high", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", *audio,
        "-movflags", "+faststart", out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def shot(k, local_t, text_delay):
        if isinstance(imgs[k], Clip):
            base = imgs[k].next().convert("RGBA")
        else:
            z = 1.0 if sc[k].get("card") else 1 + zoom_amt * (local_t / (hold + fade / 2))
            base = cover(imgs[k], z).convert("RGBA")
        return Image.alpha_composite(base, with_alpha(ovs[k], ease((local_t - text_delay) / 0.6)))

    switch = hold - fade / 2  # クロスフェードの開始時刻
    for i in range(n):
        t = i / FPS
        mix = ease((t - switch) / fade)  # 0 = 1枚目、1 = 2枚目
        frame = shot(0, t, 0.35) if mix < 1 else None
        if mix > 0:
            b = shot(1, t - switch, fade * 0.6)
            frame = b if frame is None else Image.blend(frame, b, mix)
        # 最初と最後をわずかにフェード
        edge = min(ease(t / 0.3), ease((total - t) / 0.3))
        rgb = frame.convert("RGB")
        if edge < 1:
            rgb = Image.blend(Image.new("RGB", (W, H), KINARI), rgb, edge)
        proc.stdin.write(rgb.tobytes())
    proc.stdin.close()
    for im in imgs:
        if isinstance(im, Clip):
            im.proc.kill()
    if proc.wait() != 0:
        sys.exit("動画の書き出しに失敗しました")
    print(f"できました: {out_path}({total:.1f}秒)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as fh:
        render(json.load(fh), sys.argv[2])
