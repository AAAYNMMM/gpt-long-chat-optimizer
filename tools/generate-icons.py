from __future__ import annotations

import binascii
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "extension" / "icons"


def inside_rounded_square(x: int, y: int, size: int, radius: int) -> bool:
    if radius <= x < size - radius or radius <= y < size - radius:
        return 0 <= x < size and 0 <= y < size
    cx = radius if x < radius else size - radius - 1
    cy = radius if y < radius else size - radius - 1
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", binascii.crc32(kind + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, width: int, height: int, pixels: bytes) -> None:
    rows = b"".join(
        b"\x00" + pixels[y * width * 4 : (y + 1) * width * 4]
        for y in range(height)
    )
    payload = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(payload)


def build_icon(size: int) -> bytes:
    scale = 4
    canvas = size * scale
    radius = max(3, round(canvas * 0.23))
    rgba = bytearray(canvas * canvas * 4)

    def set_pixel(x: int, y: int, color: tuple[int, int, int, int]) -> None:
        if 0 <= x < canvas and 0 <= y < canvas:
            offset = (y * canvas + x) * 4
            rgba[offset : offset + 4] = bytes(color)

    for y in range(canvas):
        for x in range(canvas):
            if not inside_rounded_square(x, y, canvas, radius):
                continue
            mix = (x + y) / max(1, 2 * canvas - 2)
            color = (
                round(104 * (1 - mix) + 17 * mix),
                round(88 * (1 - mix) + 190 * mix),
                round(245 * (1 - mix) + 171 * mix),
                255,
            )
            set_pixel(x, y, color)

    line_height = max(3, round(canvas * 0.075))
    left = round(canvas * 0.23)
    widths = (round(canvas * 0.48), round(canvas * 0.60), round(canvas * 0.34))
    centers = (round(canvas * 0.34), round(canvas * 0.50), round(canvas * 0.66))

    for center, width in zip(centers, widths):
        top = center - line_height // 2
        end = left + width
        cap = line_height // 2
        for y in range(top, top + line_height):
            for x in range(left, end):
                if (
                    x < left + cap
                    and (x - (left + cap)) ** 2 + (y - center) ** 2 > cap**2
                ):
                    continue
                if (
                    x >= end - cap
                    and (x - (end - cap - 1)) ** 2 + (y - center) ** 2 > cap**2
                ):
                    continue
                set_pixel(x, y, (255, 255, 255, 245))

    output = bytearray(size * size * 4)
    samples = scale * scale
    for y in range(size):
        for x in range(size):
            totals = [0, 0, 0, 0]
            for sy in range(scale):
                for sx in range(scale):
                    source = (((y * scale + sy) * canvas) + (x * scale + sx)) * 4
                    for channel in range(4):
                        totals[channel] += rgba[source + channel]
            target = (y * size + x) * 4
            output[target : target + 4] = bytes(round(value / samples) for value in totals)
    return bytes(output)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(OUTPUT / f"icon-{size}.png", size, size, build_icon(size))


if __name__ == "__main__":
    main()
