"""Neural cloud lighting experiments against the path-traced teacher.

python3 tools/neural/experiments.py [sun|sky|all]
Writes tools/neural/results/<target>.json and models/<name>.json.
"""
import json
import os
import sys
import time

import numpy as np

from dataset import load
from mlp import MLP, nelder_mead, train

HERE = os.path.dirname(__file__)
os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
os.makedirs(os.path.join(HERE, 'models'), exist_ok=True)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def hg(c, g):
    g2 = g * g
    d = np.maximum(1 + g2 - 2 * g * c, 1e-4)
    return (1 - g2) / (4 * np.pi * d * np.sqrt(d))


SUN_PROBES = [f'sun{i}' for i in range(6)]
SKY_PROBES = ['skyA', 'skyB', 'side0', 'side1', 'side2']
LOCAL = ['density', 'baseDensity', 'localH', 'h', 'stratiform', 'coverage', 'kind']
ANGLES = ['cosTheta', 'muSun', 'rdUp']
FEATURE_SETS = {
    # What the analytic model sees.
    'od+angle': ['od', 'cosTheta'],
    # Everything the game's marcher already computes for a lit sample.
    'game-probes': SUN_PROBES + SKY_PROBES + LOCAL + ANGLES,
    # Plus the view-ray optical depth the marcher already tracks (free).
    'game-probes+view': SUN_PROBES + SKY_PROBES + LOCAL + ANGLES + ['tauView'],
    # Half the probes: 3 sun probes, 1 sky probe (a cost saving if it holds up).
    'cheap': ['sun0', 'sun2', 'sun4', 'skyA', 'density', 'localH', 'h', 'coverage', 'cosTheta', 'muSun', 'rdUp', 'tauView'],
    # No sky probes at all.
    'sun-probes-only': SUN_PROBES + LOCAL + ANGLES + ['tauView'],
    # View-independent inputs only: if multiple scattering holds up without them it can be baked
    # into a 3D light cache once per voxel instead of per screen sample.
    'no-view': SUN_PROBES + SKY_PROBES + LOCAL + ['muSun'],
}
EXTRA = ['mip0', 'mip1', 'mip2', 'sunMip0', 'sunMip1', 'sunMip2',
         'cone0a', 'cone0b', 'cone0c', 'cone0d', 'cone1a', 'cone1b', 'cone1c', 'cone1d', 'down', 'upFar']
# Richer neighbourhood descriptor (mip-filtered density around the point and in a cone to the sun):
# affordable when the network runs per light-cache voxel rather than per screen sample.
FEATURE_SETS['descriptor'] = FEATURE_SETS['game-probes+view'] + EXTRA
FEATURE_SETS['descriptor-no-view'] = FEATURE_SETS['no-view'] + EXTRA
# + two cheap map lookups the game can provide: its cloud shadow map (sun optical depth through the
# whole layer, here: beyond the probe reach) and a column map (optical depth straight up).
SHADOW = ['farOd', 'upOd']
FEATURE_SETS['probes+maps'] = FEATURE_SETS['game-probes+view'] + SHADOW
FEATURE_SETS['cheap+maps'] = FEATURE_SETS['cheap'] + SHADOW
FEATURE_SETS['descriptor+maps'] = FEATURE_SETS['descriptor'] + SHADOW
FEATURE_SETS['no-view+maps'] = FEATURE_SETS['no-view'] + SHADOW
FEATURE_SETS['no-view+maps+log'] = FEATURE_SETS['no-view+maps'] + ['farOdLog']


def features(r, names):
    cols = []
    for n in names:
        v = r['farOd'] if n == 'farOdLog' else r[n]
        if n == 'tauView':
            v = np.log1p(np.minimum(v, 20))
        elif n in ('farOd', 'nearOd'):
            v = np.exp(-v)              # shadow-map transmittance
        elif n in ('upOd', 'farOdLog'):
            v = np.log1p(v)
        cols.append(v)
    return np.stack(cols, 1).astype(np.float32)


def split(r, mask):
    return {k: v[mask] for k, v in r.items()}


# ---------------------------------------------------------------- metrics
def metrics(pred, r, target, var_key):
    """pred, target: per-unit-extinction source. Weights: ray opacity (queries were sampled by contribution)."""
    w = r['weight']
    y = r[target]
    noise = r[var_key] * (r['albedo'] ** 2)
    eps = 0.01 * np.average(y, weights=w)
    lw = np.log(pred + eps) - np.log(y + eps)
    err2 = (w * (pred - y)) ** 2
    rel = np.sqrt(np.sum(err2) / np.sum((w * y) ** 2))
    rel_clean = np.sqrt(max(np.sum(err2) - np.sum(w ** 2 * noise), 0) / np.sum((w * y) ** 2))
    return {
        'logRmse': float(np.sqrt(np.average(lw ** 2, weights=w))),
        'relRmse': float(rel),
        'relRmseNoiseCorrected': float(rel_clean),
        'bias': float(np.sum(w * pred) / np.sum(w * y)),
        'labelNoiseRel': float(np.sqrt(np.sum(w ** 2 * noise) / np.sum((w * y) ** 2))),
    }


def per_scene(pred, r, target, var_key):
    out = {}
    for s in np.unique(r['scene']):
        m = r['scene'] == s
        out[s] = metrics(pred[m], split(r, m), target, var_key)
    return out


# ---------------------------------------------------------------- analytic baselines (sun)
def game_sun(r, a=None, b=None, c=None, gain=None, powder=None, settings=None):
    """The game's sun source per unit extinction (directLight * albedo), optionally with refit constants."""
    st = settings
    ext = r['extinction']
    a = st['msExtinction'] if a is None else a
    b = st['msScattering'] if b is None else b
    c = st['msPhase'] if c is None else c
    odx = r['od'] * ext
    cos = r['cosTheta']
    ms = 0
    ak, bk, ck = 1.0, 1.0, 1.0
    for _ in range(4):
        ms = ms + bk * ((1 - st['backLobeWeight']) * hg(cos, st['phaseForward'] * ck) + st['backLobeWeight'] * hg(cos, st['phaseBack'] * ck)) * np.exp(-odx * ak)
        ak *= a
        bk *= b
        ck *= c
    pw = st['powder'] if powder is None else powder
    powder_mix = 1 + (1 - np.exp(-r['density'] * ext * 0.12) - 1) * pw * np.clip(0.6 - 0.6 * cos, 0, 1)
    if gain is None:
        G = st['daylightSunGain']
        gain = 1 + (G - 1) * smoothstep(-0.1, 0.35, r['muSun']) * (1 - 0.55 * smoothstep(0.7, 0.98, cos))
    return r['albedo'] * gain * ms * powder_mix * r['gameInScatter']


def fit_sun_octaves(r, settings):
    w = r['weight']
    y = r['sunTotal']
    eps = 0.01 * np.average(y, weights=w)

    def f(p):
        a, b, c, lg, pw = p
        if not (0.01 < a < 1 and 0 < b < 4 and 0 < c < 2 and 0 <= pw <= 1):
            return 1e9
        pred = game_sun(r, a, b, c, np.exp(lg), pw, settings)
        return float(np.average((np.log(pred + eps) - np.log(y + eps)) ** 2, weights=w))

    x0 = [settings['msExtinction'], settings['msScattering'], settings['msPhase'], np.log(1.5), settings['powder']]
    best, val = nelder_mead(f, x0, iters=600)
    return dict(zip(['a', 'b', 'c', 'logGain', 'powder'], best.tolist())), val


# ---------------------------------------------------------------- analytic baselines (sky)
def game_sky(r, p):
    """Game-style sky visibility from the five probes, with refit weights, then an affine map."""
    wa, wb, wl, k, floor, scale, offset = p
    od = (wa * r['skyA'] + wb * r['skyB'] + wl * (r['side0'] + r['side1'] + r['side2'])) * r['extinction']
    vis = floor + (1 - floor) * np.exp(-od * k)
    return np.maximum(scale * vis + offset, 0)


def fit_sky(r, game_default):
    w = r['weight']
    y = r['skyTotal']
    eps = 0.01 * np.average(y, weights=w)
    if game_default:
        # Keep the game's visibility; only fit the affine map (its ambient scale + floor fill).
        x = r['gameSkyVis']
        A = np.stack([x, np.ones_like(x)], 1) * np.sqrt(w)[:, None]
        coef, *_ = np.linalg.lstsq(A, y * np.sqrt(w), rcond=None)
        return {'scale': float(coef[0]), 'offset': float(coef[1])}, None

    def f(p):
        if p[3] <= 0 or not (0 <= p[4] < 1):
            return 1e9
        pred = game_sky(r, p)
        return float(np.average((np.log(pred + eps) - np.log(y + eps)) ** 2, weights=w))

    best, val = nelder_mead(f, [0.4, 0.6, 0.2, 0.35, 0.15, 0.5, 0.05], iters=1500)
    return best.tolist(), val


# ---------------------------------------------------------------- runs
def run_mlps(target, var_key, train_r, test_r, sets, sizes_list, tag, log):
    results = {}
    rng = np.random.default_rng(3)
    val_mask = rng.random(len(train_r['weight'])) < 0.1
    tr, va = split(train_r, ~val_mask), split(train_r, val_mask)
    for set_name in sets:
        names = FEATURE_SETS[set_name]
        x, xv, xt = features(tr, names), features(va, names), features(test_r, names)
        y, yv = tr[target][:, None], va[target][:, None]
        # Clamp tiny weights so the network still sees thin cloud.
        w, wv = np.maximum(tr['weight'], 0.05), np.maximum(va['weight'], 0.05)
        for hidden in sizes_list:
            sizes = [len(names)] + hidden + [1]
            model = MLP(sizes, 'softsign', seed=1)
            t0 = time.time()
            log(f'{tag} {set_name} {sizes}')
            train(model, x, y, w, xv, yv, wv, epochs=100, batch=4096, lr=3e-3, loss='rel', eps=1e-3, log=log, patience=20)
            pred = np.exp(model.forward(xt)[:, 0])
            key = f'{set_name}:{"-".join(map(str, sizes))}'
            results[key] = {'macs': model.macs, 'features': names, 'trainSec': time.time() - t0,
                            'test': metrics(pred, test_r, target, var_key),
                            'perScene': per_scene(pred, test_r, target, var_key)}
            log(f'  -> {results[key]["test"]}')
            from mlp import save
            save(os.path.join(HERE, 'models', f'{tag}-{set_name}-{"-".join(map(str, hidden))}.json'), model,
                 {'features': names, 'target': target})
    return results


def main(which):
    metas, r = load('*')
    r['msTarget'] = r['albedo'] * r['ms']
    settings = metas[0]['settings']
    import re
    test_re = re.compile(os.environ.get('TEST_REGEX', '^test-'))
    keep_re = re.compile(os.environ.get('KEEP_REGEX', '.'))
    keep = np.array([bool(keep_re.search(s)) for s in r['scene']])
    r = split(r, keep)
    test_mask = np.array([bool(test_re.search(s)) for s in r['scene']])
    train_r, test_r = split(r, ~test_mask), split(r, test_mask)
    print(f'train {len(train_r["weight"])} test {len(test_r["weight"])} scenes {len(metas)}')
    log = lambda m: print(m, flush=True)
    sizes_list = [[8, 8], [16, 16], [32, 32], [64, 64]]

    if which in ('sun', 'all'):
        out = {'baselines': {}}
        game = game_sun(test_r, settings=settings)
        out['baselines']['game (as shipped)'] = {'test': metrics(game, test_r, 'sunTotal', 'msVar'),
                                                 'perScene': per_scene(game, test_r, 'sunTotal', 'msVar')}
        # Best global exposure for the shipped formula (log space), as a generous baseline.
        w = train_r['weight']
        g_tr = game_sun(train_r, settings=settings)
        k = np.exp(np.average(np.log(train_r['sunTotal'] + 1e-3) - np.log(g_tr + 1e-3), weights=w))
        out['baselines']['game + best exposure'] = {'scale': float(k), 'test': metrics(game * k, test_r, 'sunTotal', 'msVar'),
                                                    'perScene': per_scene(game * k, test_r, 'sunTotal', 'msVar')}
        params, _ = fit_sun_octaves(train_r, settings)
        tuned = game_sun(test_r, params['a'], params['b'], params['c'], np.exp(params['logGain']), params['powder'], settings)
        out['baselines']['octaves refit to teacher'] = {'params': params, 'test': metrics(tuned, test_r, 'sunTotal', 'msVar'),
                                                        'perScene': per_scene(tuned, test_r, 'sunTotal', 'msVar')}
        for k_, v in out['baselines'].items():
            log(f'sun baseline {k_}: {v["test"]}')
        out['mlp'] = run_mlps('sunTotal', 'msVar', train_r, test_r,
                              ['od+angle', 'game-probes+view', 'cheap', 'descriptor'],
                              [[16, 16], [32, 32]], 'sun', log)
        json.dump(out, open(os.path.join(HERE, 'results', 'sun.json'), 'w'), indent=1)

    if which in ('sky', 'all'):
        out = {'baselines': {}}
        aff, _ = fit_sky(train_r, True)
        pred = np.maximum(aff['scale'] * test_r['gameSkyVis'] + aff['offset'], 0)
        out['baselines']['game skyVis + best affine'] = {'params': aff, 'test': metrics(pred, test_r, 'skyTotal', 'skyVar'),
                                                         'perScene': per_scene(pred, test_r, 'skyTotal', 'skyVar')}
        p, _ = fit_sky(train_r, False)
        pred = game_sky(test_r, p)
        out['baselines']['sky probes refit to teacher'] = {'params': p, 'test': metrics(pred, test_r, 'skyTotal', 'skyVar'),
                                                           'perScene': per_scene(pred, test_r, 'skyTotal', 'skyVar')}
        for k_, v in out['baselines'].items():
            log(f'sky baseline {k_}: {v["test"]}')
        out['mlp'] = run_mlps('skyTotal', 'skyVar', train_r, test_r,
                              ['game-probes+view', 'cheap', 'descriptor'],
                              [[16, 16], [32, 32]], 'sky', log)
        json.dump(out, open(os.path.join(HERE, 'results', 'sky.json'), 'w'), indent=1)

    if which in ('ms', 'all'):
        # Multiple scattering only (orders >= 2), plus a hybrid: the game's first octave
        # (exact single-scattering form with probe optical depth) + neural MS.
        out = {'mlp': run_mlps('msTarget', 'msVar', train_r, test_r, ['game-probes+view', 'no-view'],
                               [[16, 16], [32, 32]], 'ms', log)}
        st = settings
        def single_from_probes(rr):
            c = rr['cosTheta']
            ph = (1 - st['backLobeWeight']) * hg(c, st['phaseForward']) + st['backLobeWeight'] * hg(c, st['phaseBack'])
            return rr['albedo'] * ph * np.exp(-rr['od'] * rr['extinction'])
        for key, res in out['mlp'].items():
            set_name, sizes = key.split(':')
            hidden = '-'.join(sizes.split('-')[1:-1])
            from mlp import MLP as _M
            model = _M.from_json(json.load(open(os.path.join(HERE, 'models', f'ms-{set_name}-{hidden}.json'))))
            pred = single_from_probes(test_r) + np.exp(model.forward(features(test_r, FEATURE_SETS[set_name]))[:, 0])
            res['hybridSunTotal'] = metrics(pred, test_r, 'sunTotal', 'msVar')
            log(f'hybrid {key}: {res["hybridSunTotal"]}')
        json.dump(out, open(os.path.join(HERE, 'results', 'ms.json'), 'w'), indent=1)


def round2(which):
    """Shadow-map / column-map features and their conventional counterparts."""
    metas, r = load('*')
    r['msTarget'] = r['albedo'] * r['ms']
    settings = metas[0]['settings']
    test_mask = np.array([s.startswith('test-') for s in r['scene']])
    train_r, test_r = split(r, ~test_mask), split(r, test_mask)
    log = lambda m: print(m, flush=True)
    out = {'baselines': {}}
    if which == 'sun':
        shadow = lambda rr: np.exp(-rr['farOd'])
        g = game_sun(test_r, settings=settings) * shadow(test_r)
        out['baselines']['game x shadow map'] = {'test': metrics(g, test_r, 'sunTotal', 'msVar'), 'perScene': per_scene(g, test_r, 'sunTotal', 'msVar')}
        # Refit octaves with the shadow map applied.
        w = train_r['weight']; y = train_r['sunTotal']; eps = 0.01 * np.average(y, weights=w)
        def f(p):
            a, b, c, lg, pw = p
            if not (0.01 < a < 1 and 0 < b < 4 and 0 < c < 2 and 0 <= pw <= 1):
                return 1e9
            pred = game_sun(train_r, a, b, c, np.exp(lg), pw, settings) * shadow(train_r)
            return float(np.average((np.log(pred + eps) - np.log(y + eps)) ** 2, weights=w))
        best, _ = nelder_mead(f, [settings['msExtinction'], settings['msScattering'], settings['msPhase'], np.log(1.5), settings['powder']], iters=600)
        params = dict(zip(['a', 'b', 'c', 'logGain', 'powder'], best.tolist()))
        g = game_sun(test_r, params['a'], params['b'], params['c'], np.exp(params['logGain']), params['powder'], settings) * shadow(test_r)
        out['baselines']['octaves refit x shadow map'] = {'params': params, 'test': metrics(g, test_r, 'sunTotal', 'msVar'), 'perScene': per_scene(g, test_r, 'sunTotal', 'msVar')}
        for k_, v in out['baselines'].items():
            log(f'sun baseline {k_}: {v["test"]}')
        out['mlp'] = run_mlps('sunTotal', 'msVar', train_r, test_r, ['probes+maps', 'cheap+maps', 'descriptor+maps'], [[8, 8], [16, 16], [32, 32]], 'sun', log)
    elif which == 'sky':
        def sky2(rr, p):
            wa, wb, wl, k, floor, scale, offset, kc = p
            od = (wa * rr['skyA'] + wb * rr['skyB'] + wl * (rr['side0'] + rr['side1'] + rr['side2'])) * rr['extinction'] + kc * rr['upOd']
            return np.maximum(scale * (floor + (1 - floor) * np.exp(-od * k)) + offset, 0)
        w = train_r['weight']; y = train_r['skyTotal']; eps = 0.01 * np.average(y, weights=w)
        def f(p):
            if p[3] <= 0 or not (0 <= p[4] < 1) or p[7] < 0:
                return 1e9
            return float(np.average((np.log(sky2(train_r, p) + eps) - np.log(y + eps)) ** 2, weights=w))
        best, _ = nelder_mead(f, [0.4, 0.6, 0.2, 0.35, 0.15, 0.5, 0.05, 0.05], iters=2000)
        pred = sky2(test_r, best)
        out['baselines']['sky probes + column map refit'] = {'params': best.tolist(), 'test': metrics(pred, test_r, 'skyTotal', 'skyVar'), 'perScene': per_scene(pred, test_r, 'skyTotal', 'skyVar')}
        for k_, v in out['baselines'].items():
            log(f'sky baseline {k_}: {v["test"]}')
        out['mlp'] = run_mlps('skyTotal', 'skyVar', train_r, test_r, ['probes+maps', 'cheap+maps', 'descriptor+maps'], [[8, 8], [16, 16], [32, 32]], 'sky', log)
    else:
        out['mlp'] = run_mlps('msTarget', 'msVar', train_r, test_r, ['probes+maps', 'no-view+maps', 'descriptor+maps'], [[16, 16], [32, 32]], 'ms', log)
    json.dump(out, open(os.path.join(HERE, 'results', f'{which}-maps.json'), 'w'), indent=1)


def regimes(pred, rr, target, var_key):
    out = {'all': metrics(pred, rr, target, var_key)}
    for name, mask in [('day (muSun>=0.25)', rr['muSun'] >= 0.25), ('low sun (muSun<0.25)', rr['muSun'] < 0.25)]:
        if mask.sum() > 100:
            out[name] = metrics(pred[mask], split(rr, mask), target, var_key)
    return out


def round3(which):
    """Train with dusk scenes included; report overall and per sun regime."""
    from mlp import save
    metas, r = load('*')
    r['msTarget'] = r['albedo'] * r['ms']
    settings = metas[0]['settings']
    test_mask = np.array([s.startswith('test-') for s in r['scene']])
    tr, te = split(r, ~test_mask), split(r, test_mask)
    log = lambda m: print(m, flush=True)
    log(f'train {len(tr["weight"])} ({len(set(tr["scene"]))} scenes) test {len(te["weight"])}; '
        f'train low-sun share {np.average(tr["muSun"] < 0.25, weights=tr["weight"]):.2f}, test {np.average(te["muSun"] < 0.25, weights=te["weight"]):.2f}')
    out = {'baselines': {}, 'mlp': {}}
    rng = np.random.default_rng(3)
    vm = rng.random(len(tr['weight'])) < 0.1
    a, v = split(tr, ~vm), split(tr, vm)

    def fit_mlp(target, var_key, set_name, hidden, tag):
        names = FEATURE_SETS[set_name]
        model = MLP([len(names)] + hidden + [1], 'softsign', seed=1)
        t0 = time.time()
        train(model, features(a, names), a[target][:, None], np.maximum(a['weight'], 0.05),
              features(v, names), v[target][:, None], np.maximum(v['weight'], 0.05),
              epochs=100, batch=4096, lr=3e-3, loss='rel', eps=1e-3, log=lambda m: None, patience=20)
        pred = np.exp(model.forward(features(te, names))[:, 0])
        save(os.path.join(HERE, 'models', f'r3-{tag}-{set_name}-{"-".join(map(str, hidden))}.json'), model,
             {'features': names, 'target': target})
        res = {'macs': model.macs, 'trainSec': time.time() - t0, 'test': regimes(pred, te, target, var_key),
               'perScene': per_scene(pred, te, target, var_key)}
        log(f'{tag} {set_name} {hidden}: ' + ' | '.join(f"{k} {m['relRmseNoiseCorrected']:.3f} (bias {m['bias']:.2f})" for k, m in res['test'].items()))
        return pred, res

    if which == 'sun':
        g = game_sun(te, settings=settings)
        sh = np.exp(-te['farOd'])
        for name, pred in [('game (as shipped)', g), ('game x shadow map', g * sh)]:
            out['baselines'][name] = {'test': regimes(pred, te, 'sunTotal', 'msVar')}
        # Conventional refit with the shadow map, optimising the same relative error the networks use.
        w, y = a['weight'], a['sunTotal']
        shA = np.exp(-a['farOd'])
        def f(p):
            aa, bb, cc, lg, pw = p
            if not (0.01 < aa < 1 and 0 < bb < 4 and 0 < cc < 2 and 0 <= pw <= 1):
                return 1e9
            pred = game_sun(a, aa, bb, cc, np.exp(lg), pw, settings) * shA
            return float(np.sum((w * (pred - y)) ** 2) / np.sum((w * y) ** 2))
        best, _ = nelder_mead(f, [settings['msExtinction'], settings['msScattering'], settings['msPhase'], np.log(1.5), settings['powder']], iters=800)
        params = dict(zip(['a', 'b', 'c', 'logGain', 'powder'], best.tolist()))
        pred = game_sun(te, params['a'], params['b'], params['c'], np.exp(params['logGain']), params['powder'], settings) * sh
        out['baselines']['octaves refit x shadow map'] = {'params': params, 'test': regimes(pred, te, 'sunTotal', 'msVar')}
        for k_, val in out['baselines'].items():
            log(f'sun baseline {k_}: ' + ' | '.join(f"{k} {m['relRmseNoiseCorrected']:.3f} (bias {m['bias']:.2f})" for k, m in val['test'].items()))
        for set_name, hidden in [('game-probes+view', [16, 16]), ('probes+maps', [8, 8]), ('probes+maps', [16, 16]),
                                 ('probes+maps', [32, 32]), ('cheap+maps', [16, 16]), ('descriptor+maps', [32, 32])]:
            _, out['mlp'][f'{set_name}:{hidden}'] = fit_mlp('sunTotal', 'msVar', set_name, hidden, 'sun')
    elif which == 'sky':
        def sky2(rr, p):
            wa, wb, wl, k, floor, scale, offset, kc = p
            od = (wa * rr['skyA'] + wb * rr['skyB'] + wl * (rr['side0'] + rr['side1'] + rr['side2'])) * rr['extinction'] + kc * rr['upOd']
            return np.maximum(scale * (floor + (1 - floor) * np.exp(-od * k)) + offset, 0)
        w, y = a['weight'], a['skyTotal']
        def f(p):
            if p[3] <= 0 or not (0 <= p[4] < 1) or p[7] < 0:
                return 1e9
            return float(np.sum((w * (sky2(a, p) - y)) ** 2) / np.sum((w * y) ** 2))
        best, _ = nelder_mead(f, [0.4, 0.6, 0.2, 0.35, 0.15, 0.5, 0.05, 0.05], iters=2500)
        x = a['gameSkyVis']
        A = np.stack([x, np.ones_like(x)], 1) * np.sqrt(w)[:, None]
        coef, *_ = np.linalg.lstsq(A, y * np.sqrt(w), rcond=None)
        out['baselines']['game skyVis + best affine'] = {'params': {'scale': float(coef[0]), 'offset': float(coef[1])},
                                                        'test': regimes(np.maximum(coef[0] * te['gameSkyVis'] + coef[1], 0), te, 'skyTotal', 'skyVar')}
        out['baselines']['sky probes + column map refit'] = {'params': best.tolist(), 'test': regimes(sky2(te, best), te, 'skyTotal', 'skyVar')}
        for k_, val in out['baselines'].items():
            log(f'sky baseline {k_}: ' + ' | '.join(f"{k} {m['relRmseNoiseCorrected']:.3f} (bias {m['bias']:.2f})" for k, m in val['test'].items()))
        for set_name, hidden in [('game-probes+view', [16, 16]), ('probes+maps', [8, 8]), ('probes+maps', [16, 16]),
                                 ('probes+maps', [32, 32]), ('cheap+maps', [16, 16]), ('descriptor+maps', [32, 32])]:
            _, out['mlp'][f'{set_name}:{hidden}'] = fit_mlp('skyTotal', 'skyVar', set_name, hidden, 'sky')
    else:
        st = settings
        c = te['cosTheta']
        ph = (1 - st['backLobeWeight']) * hg(c, st['phaseForward']) + st['backLobeWeight'] * hg(c, st['phaseBack'])
        single = te['albedo'] * ph * np.exp(-(te['od'] * te['extinction'] + te['farOd']))
        for set_name, hidden in [('probes+maps', [16, 16]), ('no-view+maps', [16, 16]), ('probes+maps', [32, 32]),
                                 ('no-view+maps', [32, 32]), ('descriptor+maps', [32, 32])]:
            pred, res = fit_mlp('msTarget', 'msVar', set_name, hidden, 'ms')
            res['hybridSunTotal'] = regimes(single + pred, te, 'sunTotal', 'msVar')
            log('   hybrid (exact single from probes x shadow map + neural MS): ' + ' | '.join(
                f"{k} {m['relRmseNoiseCorrected']:.3f} (bias {m['bias']:.2f})" for k, m in res['hybridSunTotal'].items()))
            out['mlp'][f'{set_name}:{hidden}'] = res
    json.dump(out, open(os.path.join(HERE, 'results', f'{which}-r3.json'), 'w'), indent=1)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == 'r3':
        round3(sys.argv[1])
        sys.exit()
    if len(sys.argv) > 2 and sys.argv[2] == 'maps':
        round2(sys.argv[1])
        sys.exit()
    main(sys.argv[1] if len(sys.argv) > 1 else 'all')
