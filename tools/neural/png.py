"""Minimal PNG writer and tonemapping (no PIL needed)."""
import struct
import zlib

import numpy as np


def write_png(path, rgb):
    """rgb: HxWx3 float in [0,1] or uint8."""
    a = rgb if rgb.dtype == np.uint8 else (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)
    h, w, _ = a.shape
    raw = b''.join(b'\x00' + a[y].tobytes() for y in range(h))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def aces(x):
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)


def to_srgb(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 0), 1 / 2.4) - 0.055)


SKY = np.array([0.32, 0.48, 0.78])
SUN = np.array([1.0, 0.96, 0.9])
AMB = np.array([0.55, 0.68, 0.95])


def compose(sun, sky, T, exposure=4.0, sky_weight=0.35):
    """Sun-lit + sky-lit cloud radiance over a flat blue backdrop, tonemapped."""
    L = sun[..., None] * SUN + sky_weight * sky[..., None] * AMB + T[..., None] * SKY * 0.25
    return to_srgb(aces(L * exposure))


def upscale(img, k):
    return np.repeat(np.repeat(img, k, axis=0), k, axis=1)


def side_by_side(images, gap=4):
    h = max(i.shape[0] for i in images)
    parts = []
    for i, im in enumerate(images):
        if i:
            parts.append(np.ones((h, gap, 3)))
        parts.append(im)
    return np.concatenate(parts, axis=1)
