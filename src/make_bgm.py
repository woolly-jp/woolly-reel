#!/usr/bin/env python3
"""静かなピアノ風のBGMを自前で合成する(権利の心配がないオリジナル音源)

使い方: python3 make_bgm.py 出力.wav
"""
import sys
import wave

import numpy as np

SR = 48000
rng = np.random.default_rng(3)


def note(freq, dur, vel=1.0):
    """ピアノ風の1音: 倍音を重ね、高い倍音ほど早く消える"""
    t = np.arange(int(SR * dur)) / SR
    out = np.zeros_like(t)
    for k in range(1, 9):
        f = freq * k * np.sqrt(1 + 0.0004 * k * k)  # わずかな不協和で弦らしく
        if f > SR / 2.2:
            break
        amp = (1.0 / k ** 1.6) * (0.6 if k % 2 == 0 else 1.0)
        decay = np.exp(-t * (0.9 + 0.55 * k) * (freq / 220) ** 0.35)
        out += amp * decay * np.sin(2 * np.pi * f * t + rng.uniform(0, 0.3))
    attack = np.minimum(1.0, t / 0.012)  # やわらかい打鍵
    release = np.minimum(1.0, (dur - t) / 0.25)
    return out * attack * release * vel


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


# ゆっくりした分散和音: Cmaj7 → Am7 → Fmaj7 → Gsus → 繰り返し
BEAT = 0.72
chords = [
    [48, 55, 64, 71, 67, 64],   # C
    [45, 52, 60, 67, 64, 60],   # Am
    [41, 48, 57, 64, 60, 57],   # F
    [43, 50, 60, 62, 67, 62],   # G
]
total = len(chords) * 6 * BEAT * 2 + 4
mix = np.zeros(int(SR * total))
pos = 0.0
for rep in range(2):
    for ch in chords:
        for i, m in enumerate(ch):
            vel = (0.5 if i == 0 else 0.34) * rng.uniform(0.85, 1.05)
            start = pos + rng.uniform(-0.008, 0.008)  # 人が弾いたような揺れ
            n = note(hz(m), 4.2 if i == 0 else 3.4, vel)
            s = max(0, int(start * SR))
            mix[s:s + len(n)] += n[:len(mix) - s]
            pos += BEAT

# 部屋の響き(簡単なリバーブ)
ir_len = int(SR * 1.8)
ir = rng.standard_normal(ir_len) * np.exp(-np.arange(ir_len) / (SR * 0.45))
ir[0] = 0
wet = np.convolve(mix, ir, mode="full")[:len(mix)]
wet /= np.max(np.abs(wet)) + 1e-9
mix = mix / (np.max(np.abs(mix)) + 1e-9) * 0.8 + wet * 0.22

# 高音を少し丸める
kernel = np.hanning(21)
mix = np.convolve(mix, kernel / kernel.sum(), mode="same")
mix = mix / np.max(np.abs(mix)) * 0.5  # 静かめの音量
stereo = np.stack([mix, np.roll(mix, 90)], axis=1)  # わずかな広がり

with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype("<i2").tobytes())
print(f"BGMをつくりました: {sys.argv[1]}({total:.0f}秒)")
