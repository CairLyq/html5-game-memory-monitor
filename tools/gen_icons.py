# -*- coding: utf-8 -*-
"""生成扩展图标（16/48/128 PNG）。需要 Pillow：pip install pillow

设计 v2：深蓝渐变圆角底 + 居中内存芯片（青色描边、左右引脚）+ 芯片内发光心跳脉冲线，
呼应"内存监测"主题。512px 超采样渲染后 LANCZOS 缩小，16px 用加粗变体保证可读。
用法：python tools/gen_icons.py
"""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 512  # 超采样画布

CYAN = (34, 211, 238)
PULSE = (125, 240, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def render(variant_scale=1.0):
    """variant_scale：线条加粗系数（16px 小图用 >1 保证可读）。"""
    w = lambda v: max(2, int(S * v * variant_scale))

    # 1) 背景：垂直渐变圆角底
    grad = Image.new('RGB', (1, 256))
    top, bottom = (18, 30, 58), (7, 12, 26)
    for y in range(256):
        grad.putpixel((0, y), lerp(top, bottom, y / 255))
    img = grad.resize((S, S)).convert('RGBA')

    # 2) 中上部青色氛围光
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([S * 0.14, S * 0.02, S * 0.86, S * 0.62], fill=CYAN + (56,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.09))
    img = Image.alpha_composite(img, glow)

    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 3) 芯片：左右各 3 根引脚 + 圆角主体 + 内圈细线
    x0, y0, x1, y1 = S * 0.235, S * 0.255, S * 0.765, S * 0.745
    pin_w, pin_len = w(0.040), S * 0.070
    for i in range(3):
        py = y0 + S * (0.13 + i * 0.24)
        d.rounded_rectangle([x0 - pin_len, py - pin_w / 2, x0 + pin_w, py + pin_w / 2],
                            radius=pin_w / 2, fill=(24, 160, 190, 255))
        d.rounded_rectangle([x1 - pin_w, py - pin_w / 2, x1 + pin_len, py + pin_w / 2],
                            radius=pin_w / 2, fill=(24, 160, 190, 255))
    d.rounded_rectangle([x0, y0, x1, y1], radius=S * 0.085,
                        fill=(10, 19, 36, 245), outline=CYAN + (255,), width=w(0.023))
    d.rounded_rectangle([x0 + S * 0.032, y0 + S * 0.032, x1 - S * 0.032, y1 - S * 0.032],
                        radius=S * 0.055, outline=CYAN + (56,), width=w(0.007))

    # 4) 芯片内四角焊盘小点（细节点缀）
    pad = w(0.014)
    for px, py in [(0.055, 0.075), (0.945, 0.075), (0.055, 0.925), (0.945, 0.925)]:
        cx = x0 + (x1 - x0) * px
        cy = y0 + (y1 - y0) * py
        d.ellipse([cx - pad, cy - pad, cx + pad, cy + pad], fill=CYAN + (150,))

    img = Image.alpha_composite(img, layer)

    # 5) 心跳脉冲线（先画模糊发光层，再叠清晰线）
    pts = [(0.315, 0.500), (0.405, 0.500), (0.440, 0.395), (0.485, 0.615),
           (0.520, 0.445), (0.545, 0.500), (0.685, 0.500)]
    pts = [(S * px, S * py) for px, py in pts]

    pulse = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    dp = ImageDraw.Draw(pulse)
    dp.line(pts, fill=PULSE + (255,), width=w(0.028), joint='curve')
    r = w(0.016)
    for p in (pts[0], pts[-1]):
        dp.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=PULSE + (255,))
    img = Image.alpha_composite(img, pulse.filter(ImageFilter.GaussianBlur(S * 0.018)))
    img = Image.alpha_composite(img, pulse)

    # 6) 圆角裁剪
    img.putalpha(ImageChops.multiply(img.getchannel('A'), rounded_mask(S, int(S * 0.22))))
    return img


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    hi = render(1.0)
    lo = render(1.8)  # 16px 小尺寸用加粗变体
    for size, src in ((128, hi), (48, hi), (16, lo)):
        path = os.path.join(out_dir, 'icon%d.png' % size)
        src.resize((size, size), Image.LANCZOS).save(path)
        print('wrote', path)


if __name__ == '__main__':
    main()
