"""Draws the ClearPage icon (a page of text lines with one highlighted line) and
writes PNGs at the sizes Chrome needs. Standard library only.

Usage: py tools/make_icons.py
"""
import os
import struct
import zlib

SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor for anti-aliasing
OUT = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")

BLUE = (29, 78, 216)
WHITE = (255, 255, 255)
YELLOW = (255, 213, 0)
INK = (29, 43, 79)


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color_at(u, v):
    """Colour at normalised coordinates (0..1), or None for transparent."""
    if not in_rounded_rect(u, v, 0.02, 0.02, 0.98, 0.98, 0.2):
        return None
    # Text lines on the page; the third one is highlighted like the read-aloud cursor.
    lines = [(0.22, 0.78), (0.22, 0.70), (0.22, 0.78), (0.22, 0.58)]
    for i, (x0, x1) in enumerate(lines):
        y0 = 0.22 + i * 0.15
        if i == 2 and in_rounded_rect(u, v, 0.15, y0 - 0.035, 0.85, y0 + 0.125, 0.04):
            if in_rounded_rect(u, v, x0, y0, x1, y0 + 0.09, 0.045):
                return INK
            return YELLOW
        if in_rounded_rect(u, v, x0, y0, x1, y0 + 0.09, 0.045):
            return WHITE
    return BLUE


def render(size):
    rows = []
    n = size * SS
    for y in range(size):
        row = bytearray([0])  # filter type 0
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = color_at((x * SS + sx + 0.5) / n, (y * SS + sy + 0.5) / n)
                    if c:
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 1
            a = acc[3]
            if a:
                row += bytes((acc[0] // a, acc[1] // a, acc[2] // a, round(255 * a / (SS * SS))))
            else:
                row += bytes(4)
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT, f"icon{s}.png")
        with open(path, "wb") as f:
            f.write(png(s, render(s)))
        print("wrote", os.path.normpath(path))
