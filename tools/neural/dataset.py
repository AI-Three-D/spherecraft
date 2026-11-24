"""Load teacher records written by tools/neural/teacherRun.mjs."""
import glob
import json
import os

import numpy as np

DATA = os.path.join(os.path.dirname(__file__), 'data')
EXTRA_FIELDS = ['mip0', 'mip1', 'mip2', 'sunMip0', 'sunMip1', 'sunMip2',
                'cone0a', 'cone0b', 'cone0c', 'cone0d', 'cone1a', 'cone1b', 'cone1c', 'cone1d', 'down', 'upFar',
                'farOd', 'nearOd', 'upOd', 'spareX']


def load_scene(name):
    meta = json.load(open(os.path.join(DATA, f'{name}.json')))
    fields = meta['fields']
    raw = np.fromfile(os.path.join(DATA, f'{name}.records.f32'), dtype=np.float32).reshape(-1, len(fields))
    rec = {f: raw[:, i].astype(np.float64) for i, f in enumerate(fields)}
    extra_path = os.path.join(DATA, f'{name}.extra.f32')
    if os.path.exists(extra_path):
        ex = np.fromfile(extra_path, dtype=np.float32).reshape(-1, len(EXTRA_FIELDS))
        rec.update({f: ex[:, i].astype(np.float64) for i, f in enumerate(EXTRA_FIELDS)})
    valid = rec['paths'] > 0
    rec = {k: v[valid] for k, v in rec.items()}
    n = rec['paths']
    rec['ms'] = rec['msSum'] / n
    rec['msVar'] = np.maximum(rec['msSq'] / n - rec['ms'] ** 2, 0) / n   # variance of the mean
    rec['sky'] = rec['skySum'] / n
    rec['skyVar'] = np.maximum(rec['skySq'] / n - rec['sky'] ** 2, 0) / n
    albedo = rec['albedo']
    # Per-unit-extinction sun source S = albedo * (single + multiple), sun irradiance 1.
    rec['sunTotal'] = albedo * (rec['single'] + rec['ms'])
    rec['skyTotal'] = albedo * rec['sky']
    rec['scene'] = np.full(len(n), name, dtype=object)
    return meta, rec


def load(pattern='*', require_extra=False):
    metas, recs = [], []
    for path in sorted(glob.glob(os.path.join(DATA, f'{pattern}.records.f32'))):
        name = os.path.basename(path)[:-len('.records.f32')]
        if require_extra and not os.path.exists(os.path.join(DATA, f'{name}.extra.f32')):
            continue
        m, r = load_scene(name)
        metas.append(m)
        recs.append(r)
    keys = [k for k in recs[0] if all(k in r for r in recs)]
    out = {k: np.concatenate([r[k] for r in recs]) for k in keys}
    return metas, out


def load_image(name):
    meta = json.load(open(os.path.join(DATA, f'{name}.json')))
    w, h = meta['image']
    acc = np.fromfile(os.path.join(DATA, f'{name}.image.f32'), dtype=np.float32).reshape(h, w, 4).astype(np.float64)
    spp = np.maximum(acc[..., 3], 1)
    return meta, {'sun': acc[..., 0] / spp, 'sky': acc[..., 1] / spp, 'T': acc[..., 2] / spp, 'spp': spp}
