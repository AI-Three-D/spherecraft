"""Light outside the cache, from what the analytic path already has: the column above, a 0.45 km sun probe,
the sun height and the height in the layer. Cross-validated by scene on the main layer, sun above the horizon.

    python3 tools/neural/far_light.py
"""
import json
import os
import numpy as np
from dataset import load
from experiments import hg, metrics, split

metas, r = load('*', require_extra=True)
st = metas[0]['settings']
r = split(r, (r['h'] > 0) & (r['density'] > 0) & (r['weight'] > 0) & (r['muSun'] > -0.03))
r['msTarget'] = r['albedo'] * r['ms']
c = r['cosTheta']
ph = (1 - st['backLobeWeight']) * hg(c, st['phaseForward']) + st['backLobeWeight'] * hg(c, st['phaseBack'])
r['T'] = np.minimum(r['single'] / ph, 1); r['Tvar'] = 0 * r['T']
U = np.log1p(np.minimum(r['upOd'], 60)); L = np.log1p(np.minimum(r['sunMip0'] * st['extinction'] * 0.45, 6))
m = np.clip(r['muSun'], 0, 1); h = np.clip(r['h'], 0, 1); one = np.ones_like(m)
X = np.stack([one, U, L, m, h, U * m, U * U, m * m, L * m, U * h, U * np.sqrt(m), np.sqrt(m)], 1)
names = sorted(set(r['scene'])); rng = np.random.default_rng(4); names = [names[i] for i in rng.permutation(len(names))]
folds = [set(names[i::5]) for i in range(5)]
deck = np.array([any(k in s for k in ('overcast', 'rain', 'storm')) for s in r['scene']])
s5 = lambda a, b, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - a) / (b - a), 0, 1))
loc = np.expm1(L)
old = {'msTarget': (0.055 + 0.034 * s5(-.2, .6, r['muSun'])) * np.exp(-loc * .22) * .99,
       'skyTotal': np.exp(-.7298 - .66 * np.log1p(np.minimum(r['upOd'], 40)) + .6465 * np.log1p(np.minimum(loc * .667, 6)) + .2069 * m + .7562 * h),
       'T': np.exp(-loc) * 0.38}
def fit(X, y, w):
    mean = np.average(y, weights=w); b = np.linalg.lstsq(X * np.sqrt(w)[:, None], np.log(y + .02 * mean) * np.sqrt(w), rcond=None)[0]
    for _ in range(60):                       # Gauss-Newton on squared error of exp(Xb), damped
        p = np.exp(np.clip(X @ b, -20, 3)); J = X * (w * p)[:, None]; e = w * (y - p)
        A = J.T @ J; A += 1e-3 * np.diag(np.diag(A)) + 1e-9 * np.eye(len(b)); d = np.linalg.solve(A, J.T @ e)
        step = 1.0; base = np.sum(e ** 2)
        while step > 1e-3 and np.sum((w * (y - np.exp(np.clip(X @ (b + step * d), -20, 3)))) ** 2) > base: step /= 2
        b = b + step * d
        if np.linalg.norm(step * d) < 1e-5: break
    return b
out = {}
print('separate fits for fair and deck weather, 5-fold by scene')
for target, var in [('msTarget', 'msVar'), ('skyTotal', 'skyVar'), ('T', 'Tvar')]:
    p = np.zeros(len(m)); line = []
    for tag, g in [('fair', ~deck), ('deck', deck)]:
        for f in folds:
            t = np.array([s in f for s in r['scene']])
            p[t & g] = np.exp(np.clip(X[t & g] @ fit(X[~t & g], r[target][~t & g], r['weight'][~t & g]), -20, 3))
        out.setdefault(tag, {})[target] = fit(X[g], r[target][g], r['weight'][g]).tolist()
    if target != 'msTarget': p = np.minimum(p, 1)
    for label, k in [('decks low sun', deck & (m < .26)), ('decks high sun', deck & (m >= .26)), ('fair low sun', ~deck & (m < .26)), ('fair high sun', ~deck & (m >= .26)), ('fair sun > 40 deg', ~deck & (m >= .64))]:
        q = split(r, k); a, o = metrics(p[k], q, target, var), metrics(old[target][k], q, target, var)
        line.append(f"{label}: {o['relRmseNoiseCorrected']:.2f}({o['bias']:.2f}) -> {a['relRmseNoiseCorrected']:.2f}({a['bias']:.2f})")
    print(target, ' | '.join(line))
json.dump({'features': '1 U L m h Um UU mm Lm Uh Usqrt(m) sqrt(m)', **out}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results', 'far_light.json'), 'w'))
