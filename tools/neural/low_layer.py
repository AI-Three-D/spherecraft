"""Light on the low stratus layer from the deck above it, fitted to the teacher's low-layer points.

    python3 tools/neural/low_layer.py
"""
import numpy as np
from dataset import load
from experiments import hg, metrics, split
from mlp import nelder_mead

metas, r = load('*', require_extra=True)
st = metas[0]['settings']
R0 = float(np.array(metas[0]['uniforms'])[40])
rad = np.sqrt(r['px'] ** 2 + r['py'] ** 2 + r['pz'] ** 2)
r['hLow'] = (rad - R0 - st['lowCloudBottomKm']) / (st['lowCloudTopKm'] - st['lowCloudBottomKm'])
r['msTarget'] = r['albedo'] * r['ms']
c = r['cosTheta']
ph = (1 - st['backLobeWeight']) * hg(c, st['phaseForward']) + st['backLobeWeight'] * hg(c, st['phaseBack'])
r['T'] = r['single'] / ph
r['Tvar'] = 0 * r['T']
m = (r['h'] <= 0) & (r['weight'] > 0) & (r['hLow'] > 0) & (r['hLow'] < 1) & (r['muSun'] > -0.1)
low = split(r, m)
names = sorted(set(low['scene']))
val = set(names[1::3])
vm = np.array([s in val for s in low['scene']])
a, v = split(low, ~vm), split(low, vm)
print(f'low-layer points {m.sum()}, train scenes {len(names) - len(val)}, held-out {len(val)}; planet radius {R0}, hLow {np.percentile(low["hLow"], [1, 50, 99]).round(2)}')
X = lambda q: np.stack([np.ones(len(q['weight'])), np.log1p(np.minimum(q['upOd'], 60)), np.log1p(np.minimum(q['farOd'], 60)), q['muSun'], q['hLow']], 1)
for target, var in [('skyTotal', 'skyVar'), ('msTarget', 'msVar'), ('T', 'Tvar')]:
    Xa, y, w = X(a), a[target], a['weight']
    eps = .02 * np.average(y, weights=w)
    b, *_ = np.linalg.lstsq(Xa * np.sqrt(w)[:, None], np.log(y + eps) * np.sqrt(w), rcond=None)
    b, _ = nelder_mead(lambda q: float(np.sum((w * (np.exp(np.clip(Xa @ q, -30, 5)) - y)) ** 2) / np.sum((w * y) ** 2)), b, step=.1, iters=3000)
    p = np.exp(X(v) @ b)
    if target == 'T': p = np.minimum(p, 1)
    k = metrics(p, v, target, var)
    const = metrics(np.full(len(v['weight']), np.average(y, weights=w)), v, target, var)
    print(f"{target:9s} mean {np.average(v[target], weights=v['weight']):.4f}  fit {k['relRmseNoiseCorrected']:.3f} ({k['bias']:.2f})  constant {const['relRmseNoiseCorrected']:.3f}   coef [1, log1p up, log1p far, mu, hLow] {np.round(b, 3).tolist()}")
fill = 0.27 + 0.73 * np.exp(-low['density'] * 0)
for s in sorted(set(low['scene']))[:40]:
    k = low['scene'] == s
    if k.sum() > 600: print(f"  {s:26s} n={k.sum():5d} sky {np.average(low['skyTotal'][k], weights=low['weight'][k]):.3f}  ms {np.average(low['msTarget'][k], weights=low['weight'][k]):.3f} T {np.average(low['T'][k], weights=low['weight'][k]):.3f}  upOd p50 {np.median(low['upOd'][k]):.1f}")

# A tiny network on the same two columns. Foggy (thin deck) and rain/storm (thick deck) differ by 8x.
from mlp import MLP, train  # noqa: E402
def F(q, far=True):
    cols = [np.log1p(np.minimum(q['upOd'], 80)), q['muSun'], q['hLow']]
    if far: cols += [np.log1p(np.minimum(q['farOd'], 80)), np.exp(-q['farOd'])]
    return np.stack(cols, 1).astype(np.float32)
print('networks (held-out scenes):')
for far in (True, False):
    for target, var in [('skyTotal', 'skyVar'), ('msTarget', 'msVar'), ('T', 'Tvar')]:
        mean = np.average(a[target], weights=a['weight'])
        ps = []
        for seed in range(2):
            net = MLP([F(a, far).shape[1], 8, 8, 1], 'softsign', seed=seed)
            train(net, F(a, far), a[target][:, None], np.maximum(a['weight'], .05), F(v, far), v[target][:, None], np.maximum(v['weight'], .05),
                  epochs=120, batch=1024, lr=3e-3, loss='rel', eps=.1 * mean, log=lambda s: None, patience=25, seed=seed)
            ps.append(net.forward(F(v, far))[:, 0])
        p = np.exp(np.mean(ps, 0))
        k = metrics(p, v, target, var)
        thick = v['upOd'] > 8
        kt = metrics(p[thick], split(v, thick), target, var)
        print(f"  far={far!s:5s} {target:9s} all {k['relRmseNoiseCorrected']:.3f} ({k['bias']:.2f})  under thick deck {kt['relRmseNoiseCorrected']:.3f} ({kt['bias']:.2f})")
