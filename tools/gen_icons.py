# -*- coding: utf-8 -*-
"""生成扩展图标（16/48/128 PNG），仅用标准库（zlib/struct）。

设计：深蓝圆角底 + 底部内存条（绿→黄→橙→红渐变）+ 青色波形扫描线。
用法：python tools/gen_icons.py
"""
import math
import os
import struct
import zlib


def _chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    c += struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    return c


def write_png(path, size, get_pixel):
    rows = []
    for y in range(size):
        row = b'\x00'
        for x in range(size):
            r, g, b, a = get_pixel(x, y, size)
            row += bytes((r, g, b, a))
        rows.append(row)
    raw = b''.join(rows)
    png = (
        b'\x89PNG\r\n\x1a\n'
        + _chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        + _chunk(b'IDAT', zlib.compress(raw, 9))
        + _chunk(b'IEND', b'')
    )
    with open(path, 'wb') as f:
        f.write(png)


def make_pixel(size):
    radius = size * 0.22

    def pixel(x, y, s):
        # 圆角裁剪
        cx = min(x, s - 1 - x)
        cy = min(y, s - 1 - y)
        if cx < radius and cy < radius:
            dx, dy = radius - cx, radius - cy
            if dx * dx + dy * dy > radius * radius:
                return (0, 0, 0, 0)

        # 背景：深蓝渐变
        t = y / s
        bg = (13 + int(6 * t), 20 + int(8 * t), 42 + int(6 * t))

        # 波形扫描线（青色）
        wy = s * (0.16 + 0.10 * math.sin((x / s) * math.pi * 4 + 0.8))
        if abs(y - wy) < max(1.0, s * 0.02):
            return (34, 211, 238, 255)

        # 内存条：底部 36%，占宽 44%
        bar_l = s * 0.28
        bar_r = s * 0.72
        bar_top = s * 0.52
        bar_bottom = s * 0.88
        if bar_l <= x < bar_r and bar_top <= y <= bar_bottom:
            frac = (bar_bottom - y) / (bar_bottom - bar_top)
            if frac < 0.25:
                c = (52, 197, 26)      # 绿
            elif frac < 0.5:
                c = (250, 173, 20)     # 黄
            elif frac < 0.75:
                c = (250, 120, 20)     # 橙
            else:
                c = (234, 102, 104)    # 红
            return c + (255,)

        return bg + (255,)

    return pixel


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(out_dir, 'icon%d.png' % size)
        write_png(path, size, make_pixel(size))
        print('wrote', path)


if __name__ == '__main__':
    main()
