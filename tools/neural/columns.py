"""Cheap analytic bounce and sky light from column optical depths, fitted to the path-traced teacher.

The runtime preview only has a short sun probe, the projected shadow map (the sun column) and the
weather. This fits log-linear forms on those quantities and reports held-out error next to the
networks, so the analytic fallback can match the learned terms where the cache is unavailable.

    python3 tools/neural/columns.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dataset import load  # noqa: E402
from experiments import FEATURE_SETS, features, hg, regimes, split  # noqa: E402
from mlp import MLP, nelder_mead  # noqa: E402


def design(r, up_proxy, no_sun=False):
    sun_col = r['nearOd'] + r['farOd']
    if no_sun:
        # The projected shadow map is missing at low sun and too coarse for small clouds.
        sun_col = np.zeros_like(sun_col)
    up_col = sun_col * np.maximum(r['muSun'], 0.05) if up_proxy else r['upOd']
    local = r['sunMip0'] * r['extinction'] * 0.3
    return np.stack([np.ones_like(sun_col), np.log1p(sun_col), np.log1p(up_col), np.log1p(local),
                     r['muSun'], np.clip(r['h'], 0, 1)], 1)


def fit_loglinear(a, target, up_proxy, no_sun=False):
    X, y, w = design(a, up_proxy, no_sun), a[target], a['weight']
    eps = 0.01 * np.average(y, weights=w)
    sw = np.sqrt(w)[:, None]
    beta, *_ = np.linalg.lstsq(X * sw, np.log(y + eps) * sw[:, 0], rcond=None)

    def rel(b):
        pred = np.exp(np.clip(X @ b, -30, 10))
        return float(np.sum((w * (pred - y)) ** 2) / np.sum((w * y) ** 2))
    beta, _ = nelder_mead(rel, beta, step=0.1, iters=3000)
    return beta


def main():
    metas, r = load('*')
    r['msTarget'] = r['albedo'] * r['ms']
    st = metas[0]['settings']
    test = np.array([s.startswith('test-') for s in r['scene']])
    a, te = split(r, ~test), split(r, test)
    c = te['cosTheta']
    phase = (1 - st['backLobeWeight']) * hg(c, st['phaseForward']) + st['backLobeWeight'] * hg(c, st['phaseBack'])
    single = te['albedo'] * phase * np.exp(-(te['od'] * te['extinction'] + te['farOd']))
    out = {}
    fmt = lambda res: ' | '.join(f"{k} {m['relRmseNoiseCorrected']:.3f} (bias {m['bias']:.2f})" for k, m in res.items())
    for up_proxy, no_sun in ((False, False), (True, False), (False, True)):
        tag = 'up column = sun column x mu' if up_proxy else 'true up column'
        if no_sun:
            tag = 'up column and local probe only'
        b_ms = fit_loglinear(a, 'msTarget', up_proxy, no_sun)
        b_sky = fit_loglinear(a, 'skyTotal', up_proxy, no_sun)
        X = design(te, up_proxy, no_sun)
        ms = np.exp(X @ b_ms)
        sky = np.exp(X @ b_sky)
        res = {'msCoefficients': b_ms.tolist(), 'skyCoefficients': b_sky.tolist(),
               'ms': regimes(ms, te, 'msTarget', 'msVar'), 'hybridSun': regimes(single + ms, te, 'sunTotal', 'msVar'),
               'sky': regimes(sky, te, 'skyTotal', 'skyVar')}
        out[tag] = res
        print(f'{tag}\n  coefficients [1, log1p sunCol, log1p upCol, log1p local, mu, h]\n'
              f'  ms  {np.round(b_ms, 4).tolist()}\n  sky {np.round(b_sky, 4).tolist()}')
        for k in ('ms', 'hybridSun', 'sky'):
            print(f'  {k:9s} {fmt(res[k])}')
    # Reference rows: the deployed networks on the same split.
    for name, path, target, var in [('ms net', 'r4-ms-no-view+maps+log-16-16.json', 'msTarget', 'msVar'),
                                    ('sky net', 'r3-sky-no-view+maps-16-16.json', 'skyTotal', 'skyVar')]:
        d = json.load(open(os.path.join(HERE, 'models', path)))
        m = MLP.from_json(d)
        pred = np.exp(m.forward(features(te, d['features']))[:, 0])
        res = regimes(pred, te, target, var)
        out[name] = res
        print(f'{name:9s} {fmt(res)}')
        if name == 'ms net':
            out['hybrid sun (ms net)'] = regimes(single + pred, te, 'sunTotal', 'msVar')
            print(f'hybrid sun (ms net) {fmt(out["hybrid sun (ms net)"])}')
    json.dump(out, open(os.path.join(HERE, 'results', 'columns.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
