# The analytic grass canopy against its teacher (teacherRun.mjs): how far the ground's grass colour is from the field
# drawn as it is, by the spot's slant through the canopy, the sun's height and the hotspot, and a correction fitted to it.
# python3 tools/perf/grass/teacherFit.py DATA.json
import json
import math
import sys

import numpy as np

rows = json.load(open(sys.argv[1]))
# Spots the sight line sees (a slant above the canopy's edge-on), lit, near enough for the teacher's window to hold grass.
rows = [r for r in rows if r['slant'] > 0.008 and r['d'] <= 190 and min(r['ground']) > 5 and min(r['truth']) > 5]
print(f'{len(rows)} spots from {len(set(r["view"] for r in rows))} views')


def lin(c):
    # sRGB-ish 8-bit to linear (the frame is tone mapped; ratios in linear light are what the shader scales)
    c = np.asarray(c, dtype=float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


truth = np.array([lin(r['truth']) for r in rows])
ground = np.array([lin(r['ground']) for r in rows])
ratio = truth / np.maximum(ground, 1e-4)
grey = (truth @ [0.2126, 0.7152, 0.0722]) / np.maximum(ground @ [0.2126, 0.7152, 0.0722], 1e-4)
slant = np.array([r['slant'] for r in rows])
sun_up = np.array([r['sunUp'] for r in rows])
hot = np.array([r['hot'] for r in rows])
dist = np.array([r['d'] for r in rows])
views = np.array([r['view'] for r in rows])

print('\nby view: grey ratio truth / ground at each distance')
for v in dict.fromkeys(views):
    m = views == v
    print(f'  {v:32s}', ' '.join(f'{d:>3.0f}:{g:.2f}' for d, g in zip(dist[m], grey[m])))

# Features for a correction of the ground's grass colour (log of the grey ratio): log slant, the hotspot, the sun.
def features(slant, sun_up, hot):
    ls = np.log(np.clip(slant, 0.008, 1.0))
    return np.stack([np.ones_like(ls), ls, ls * ls, hot, hot * ls, sun_up, sun_up * ls, hot * hot], axis=1)


X = features(slant, sun_up, hot)
y = np.log(np.clip(grey, 0.2, 5.0))
# Held-out by view: fit on the others, score on each.
errs_fit, errs_none = [], []
for v in dict.fromkeys(views):
    m = views == v
    coef, *_ = np.linalg.lstsq(X[~m], y[~m], rcond=None)
    errs_fit.append(np.abs(X[m] @ coef - y[m]).mean())
    errs_none.append(np.abs(y[m]).mean())
coef, *_ = np.linalg.lstsq(X, y, rcond=None)
print(f'\nmean |log ratio|: none {np.mean(errs_none):.3f}, fitted (held out by view) {np.mean(errs_fit):.3f}')
print('coefficients [1, ls, ls^2, hot, hot*ls, sunUp, sunUp*ls, hot^2]:', ', '.join(f'{c:.4f}' for c in coef))
# Per channel, the hue the ground is off by (mean of truth over ground per channel over the grey ratio).
hue = (ratio / grey[:, None]).mean(axis=0)
print('hue (per channel, over grey):', ', '.join(f'{h:.3f}' for h in hue))
json.dump({'coef': coef.tolist(), 'hue': hue.tolist()}, open(sys.argv[1].replace('.json', '-fit.json'), 'w'))
