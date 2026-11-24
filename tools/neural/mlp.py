"""Tiny numpy MLP with manual backprop, Adam, and losses suited to Monte Carlo labels."""
import json

import numpy as np


def act(x, kind):
    if kind == 'relu':
        return np.maximum(x, 0)
    if kind == 'softsign':
        return x / (1 + np.abs(x))
    if kind == 'tanh':
        return np.tanh(x)
    raise ValueError(kind)


def act_grad(x, y, kind):
    if kind == 'relu':
        return (x > 0).astype(x.dtype)
    if kind == 'softsign':
        d = 1 + np.abs(x)
        return 1 / (d * d)
    if kind == 'tanh':
        return 1 - y * y
    raise ValueError(kind)


class MLP:
    """Outputs z (n_out). Predictions are exp(z) (positive radiance)."""

    def __init__(self, sizes, activation='softsign', seed=0):
        rng = np.random.default_rng(seed)
        self.sizes = sizes
        self.activation = activation
        self.W = [rng.normal(0, np.sqrt(2.0 / a), (a, b)).astype(np.float32) for a, b in zip(sizes[:-1], sizes[1:])]
        self.b = [np.zeros(b, np.float32) for b in sizes[1:]]
        self.mean = np.zeros(sizes[0], np.float32)
        self.scale = np.ones(sizes[0], np.float32)
        self.out_bias = np.zeros(sizes[-1], np.float32)

    @property
    def macs(self):
        return sum(a * b for a, b in zip(self.sizes[:-1], self.sizes[1:]))

    def forward(self, x, keep=False):
        h = (x - self.mean) * self.scale
        cache = [(None, h)]
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            pre = h @ W + b
            h = pre if i == len(self.W) - 1 else act(pre, self.activation)
            cache.append((pre, h))
        z = h + self.out_bias
        return (z, cache) if keep else z

    def backward(self, cache, dz):
        gW, gb = [], []
        g = dz
        for i in range(len(self.W) - 1, -1, -1):
            pre, h = cache[i + 1]
            if i != len(self.W) - 1:
                g = g * act_grad(pre, h, self.activation)
            gW.insert(0, cache[i][1].T @ g)
            gb.insert(0, g.sum(0))
            g = g @ self.W[i].T
        return gW, gb

    def to_json(self):
        return {'sizes': self.sizes, 'activation': self.activation, 'mean': self.mean.tolist(),
                'scale': self.scale.tolist(), 'outBias': self.out_bias.tolist(),
                'W': [w.tolist() for w in self.W], 'b': [b.tolist() for b in self.b]}

    @staticmethod
    def from_json(d):
        m = MLP(d['sizes'], d['activation'])
        m.mean = np.array(d['mean'], np.float32)
        m.scale = np.array(d['scale'], np.float32)
        m.out_bias = np.array(d['outBias'], np.float32)
        m.W = [np.array(w, np.float32) for w in d['W']]
        m.b = [np.array(b, np.float32) for b in d['b']]
        return m


def loss_grad(z, y, w, kind, eps):
    """z: log prediction, y: noisy linear target, w: sample weights. Returns loss, dL/dz."""
    p = np.exp(np.clip(z, -30, 10))
    if kind == 'log':
        ly = np.log(y + eps)
        lp = np.log(p + eps)
        r = lp - ly
        return (w[:, None] * r * r).sum() / w.sum(), 2 * w[:, None] * r * (p / (p + eps)) / w.sum()
    if kind == 'rel':
        # Relative L2 with the prediction (stop-gradient) in the denominator: unbiased for
        # zero-mean label noise (Lehtinen et al. 2018, Noise2Noise).
        d = (p + eps) ** 2
        r = p - y
        return (w[:, None] * r * r / d).sum() / w.sum(), 2 * w[:, None] * r * p / d / w.sum()
    raise ValueError(kind)


def train(model, x, y, w, xv, yv, wv, epochs=200, batch=2048, lr=3e-3, loss='rel', eps=0.01, seed=0, log=print,
          patience=30, offset=None, offset_v=None):
    """offset: optional per-sample log-scale prior added to the output (prediction = exp(z + offset))."""
    if offset is None:
        offset = np.zeros((len(x), 1), np.float32)
    if offset_v is None:
        offset_v = np.zeros((len(xv), 1), np.float32)
    rng = np.random.default_rng(seed)
    model.mean = x.mean(0).astype(np.float32)
    model.scale = (1 / np.maximum(x.std(0), 1e-4)).astype(np.float32)
    model.out_bias = (np.log(np.average(y, axis=0, weights=w) + eps) - np.average(offset[:, 0], weights=w)).astype(np.float32)
    params = model.W + model.b
    m = [np.zeros_like(p) for p in params]
    v = [np.zeros_like(p) for p in params]
    t = 0
    best = (np.inf, None)
    stale = 0
    n = len(x)
    for epoch in range(epochs):
        order = rng.permutation(n)
        rate = lr * 0.5 * (1 + np.cos(np.pi * epoch / epochs))
        for s in range(0, n, batch):
            idx = order[s:s + batch]
            z, cache = model.forward(x[idx], keep=True)
            _, dz = loss_grad(z + offset[idx], y[idx], w[idx], loss, eps)
            gW, gb = model.backward(cache, dz.astype(np.float32))
            t += 1
            for i, g in enumerate(gW + gb):
                m[i] = 0.9 * m[i] + 0.1 * g
                v[i] = 0.999 * v[i] + 0.001 * g * g
                params[i] -= rate * (m[i] / (1 - 0.9 ** t)) / (np.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8)
        vl, _ = loss_grad(model.forward(xv) + offset_v, yv, wv, loss, eps)
        if vl < best[0] - 1e-5:
            best = (vl, [p.copy() for p in params])
            stale = 0
        else:
            stale += 1
        if epoch % 25 == 0 or epoch == epochs - 1:
            log(f'  epoch {epoch:4d} val {vl:.5f}')
        if stale > patience:
            break
    for p, q in zip(params, best[1]):
        p[...] = q
    return best[0]


def nelder_mead(f, x0, step=0.2, iters=400, tol=1e-7):
    n = len(x0)
    pts = [np.array(x0, float)] + [np.array(x0, float) + step * np.eye(n)[i] * (abs(x0[i]) + 0.1) for i in range(n)]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        order = np.argsort(vals)
        pts = [pts[i] for i in order]
        vals = [vals[i] for i in order]
        if abs(vals[-1] - vals[0]) < tol:
            break
        c = np.mean(pts[:-1], axis=0)
        xr = c + (c - pts[-1])
        fr = f(xr)
        if fr < vals[0]:
            xe = c + 2 * (c - pts[-1])
            fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c)
            fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                pts = [pts[0]] + [pts[0] + 0.5 * (p - pts[0]) for p in pts[1:]]
                vals = [vals[0]] + [f(p) for p in pts[1:]]
    i = int(np.argmin(vals))
    return pts[i], vals[i]


def save(path, model, extra):
    json.dump({**model.to_json(), **extra}, open(path, 'w'))
