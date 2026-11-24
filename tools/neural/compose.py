"""Compose comparison sheets (game | refit | neural | path-traced) and image-level error metrics.

python3 tools/neural/compose.py [scene-prefix]
"""
import json
import os
import sys

import numpy as np

from dataset import DATA, load_image
from png import compose, side_by_side, upscale, write_png

OUT = os.path.join(os.path.dirname(__file__), 'out')
os.makedirs(OUT, exist_ok=True)
SKY_WEIGHT = 0.35


def load_render(name, w, h):
    acc = np.fromfile(os.path.join(DATA, f'{name}.render.f32'), dtype=np.float32).reshape(h, w, 16).astype(np.float64)
    n = np.maximum(acc[..., 7], 1)
    keys = ['sunGame', 'sunFit', 'sunNn', 'skyGame', 'skyFit', 'skyNn', 'T', None, 'sunOne', 'skyOne', 'sunTwo', 'skyTwo', 'sunFour', 'skyFour']
    return {k: acc[..., i] / n for i, k in enumerate(keys) if k}


def blur2(x):
    h, w = x.shape[0] // 2 * 2, x.shape[1] // 2 * 2
    x = x[:h, :w]
    return 0.25 * (x[0::2, 0::2] + x[1::2, 0::2] + x[0::2, 1::2] + x[1::2, 1::2])


def errors(pred, ref):
    """Relative RMSE on 2x2-averaged images (reduces reference Monte Carlo noise) and mean ratio."""
    p, r = blur2(pred), blur2(ref)
    return {'relRmse': float(np.sqrt(np.mean((p - r) ** 2) / np.mean(r ** 2))), 'meanRatio': float(p.mean() / r.mean())}


def main(prefix):
    summary = {}
    for f in sorted(os.listdir(DATA)):
        if not f.endswith('.render.f32') or not f.startswith(prefix):
            continue
        name = f[:-len('.render.f32')]
        meta, ref = load_image(name)
        w, h = meta['image']
        r = load_render(name, w, h)
        # Noise estimate of the reference: difference to its own 2x2 average.
        variants = {
            'game': (r['sunGame'], r['skyGame']),
            'refit': (r['sunFit'], r['skyFit']),
            'neural': (r['sunNn'], r['skyNn']),
            'neural, 1 point per ray': (r['sunOne'], r['skyOne']),
            'neural, 2 points per ray': (r['sunTwo'], r['skyTwo']),
            'neural, 4 points per ray': (r['sunFour'], r['skyFour']),
        }
        row = {}
        tiles = []
        for key, (sun, sky) in variants.items():
            row[key] = {'sun': errors(sun, ref['sun']), 'sky': errors(sky, ref['sky']),
                        'total': errors(sun + SKY_WEIGHT * sky, ref['sun'] + SKY_WEIGHT * ref['sky'])}
            tiles.append(upscale(compose(sun, sky, r['T'], sky_weight=SKY_WEIGHT), 3))
        tiles.append(upscale(compose(ref['sun'], ref['sky'], ref['T'], sky_weight=SKY_WEIGHT), 3))
        write_png(os.path.join(OUT, f'{name}.png'), side_by_side(tiles))
        # Sun-only sheet: shows the shape of the lighting without the sky fill.
        sun_tiles = [upscale(compose(v[0], 0 * v[1], r['T'], sky_weight=0), 3) for v in variants.values()]
        sun_tiles.append(upscale(compose(ref['sun'], 0 * ref['sky'], ref['T'], sky_weight=0), 3))
        write_png(os.path.join(OUT, f'{name}.sun.png'), side_by_side(sun_tiles))
        summary[name] = row
        print(name, {k: (round(v['total']['relRmse'], 3), round(v['total']['meanRatio'], 3)) for k, v in row.items()})
    json.dump(summary, open(os.path.join(os.path.dirname(__file__), 'results', 'images.json'), 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'test-')
