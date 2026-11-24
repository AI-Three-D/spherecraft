"""Low stratus light from the sun column alone (the projected shadow map the shader already reads)."""
import numpy as np
exec(open('low_layer.py').read().split("print(f'low-layer points")[0])
from mlp import MLP, train
keep = low['muSun'] > 0.12            # the map exists only with the sun well above the horizon
low = split(low, keep)
names = sorted(set(low['scene'])); folds = [set(names[i::4]) for i in range(4)]
F = lambda q: np.stack([np.log1p(np.minimum(q['farOd'], 80)), np.exp(-q['farOd']), q['muSun'], q['hLow']], 1).astype(np.float32)
S = lambda q: np.stack([np.ones(len(q['weight'])), np.log1p(np.minimum(q['farOd'], 80)), q['muSun'], q['hLow']], 1)
print(len(names), 'scenes,', len(low['weight']), 'points; 4-fold by scene')
for target, var in [('msTarget', 'msVar'), ('skyTotal', 'skyVar'), ('T', 'Tvar')]:
    res = {'constant': np.zeros(len(low['weight'])), 'log-linear': np.zeros(len(low['weight'])), 'net 4-8-8-1': np.zeros(len(low['weight']))}
    coefs = []
    for fold in folds:
        t = np.array([s in fold for s in low['scene']])
        a, v = split(low, ~t), split(low, t)
        y, w = a[target], a['weight']
        mean = np.average(y, weights=w)
        res['constant'][t] = mean
        b, *_ = np.linalg.lstsq(S(a) * np.sqrt(w)[:, None], np.log(y + .02 * mean) * np.sqrt(w), rcond=None)
        b, _ = nelder_mead(lambda q: float(np.sum((w * (np.exp(np.clip(S(a) @ q, -30, 5)) - y)) ** 2) / np.sum((w * y) ** 2)), b, step=.1, iters=1500)
        coefs.append(b); res['log-linear'][t] = np.exp(S(v) @ b)
        net = MLP([4, 8, 8, 1], 'softsign', seed=0)
        train(net, F(a), y[:, None], np.maximum(w, .05), F(v), v[target][:, None], np.maximum(v['weight'], .05), epochs=100, batch=1024, lr=3e-3, loss='rel', eps=.1 * mean, log=lambda s: None, patience=25, seed=0)
        res['net 4-8-8-1'][t] = np.exp(net.forward(F(v))[:, 0])
    thick = np.array([('rain' in s or 'storm' in s) for s in low['scene']])
    for k, p in res.items():
        m = metrics(p, low, target, var); mt = metrics(p[thick], split(low, thick), target, var)
        print(f"{target:9s} {k:12s} all {m['relRmseNoiseCorrected']:.3f} ({m['bias']:.2f})  rain+storm {mt['relRmseNoiseCorrected']:.3f} ({mt['bias']:.2f})")
    print('          coefficients', np.round(np.mean(coefs, 0), 3).tolist())
