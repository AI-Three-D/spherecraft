// js/assets/gltf/AnimationSampler.js

export class AnimationSampler {
    /**
     * Sample all channels of an animation at `time`.
     * @returns {Map<nodeIndex, {translation?, rotation?, scale?}>}
     */
    static sample(animation, time) {
        const out = new Map();
        // No wrap here. _sampleChannel clamps past either end to the
        // boundary keyframe, which is what a held one-shot needs.
        // Looping is the caller's responsibility.
        for (const ch of animation.channels) {
            if (ch.targetNodeIndex < 0) continue;
            if (!out.has(ch.targetNodeIndex)) out.set(ch.targetNodeIndex, {});
            out.get(ch.targetNodeIndex)[ch.targetPath] = this._sampleChannel(ch, time);
        }
        return out;
    }

    static _sampleChannel(ch, time) {
        const ts = ch.times, vs = ch.values, n = ts.length;
        const nc = this._nc(ch.targetPath);

        if (n === 0) return null;
        if (n === 1 || time <= ts[0]) return this._read(vs, 0, nc);
        if (time >= ts[n - 1]) return this._read(vs, n - 1, nc);

        // Binary search
        let lo = 0, hi = n - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (ts[mid] <= time) lo = mid; else hi = mid;
        }

        const f = (time - ts[lo]) / (ts[hi] - ts[lo]);
        if (ch.interpolation === 'STEP') return this._read(vs, lo, nc);

        const a = this._read(vs, lo, nc);
        const b = this._read(vs, hi, nc);
        return ch.targetPath === 'rotation' ? this._slerp(a, b, f) : this._lerp(a, b, f);
    }

    static _nc(path) {
        return path === 'rotation' ? 4 : 3;
    }

    static _read(vs, i, nc) {
        const o = i * nc, out = new Array(nc);
        for (let k = 0; k < nc; k++) out[k] = vs[o + k];
        return out;
    }

    static _lerp(a, b, t) {
        const out = new Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
        return out;
    }

    static _slerp(a, b, t) {
        let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
        const b2 = dot < 0 ? (dot = -dot, [-b[0], -b[1], -b[2], -b[3]]) : b;

        if (dot > 0.9995) {
            const out = this._lerp(a, b2, t);
            const len = Math.sqrt(out[0] ** 2 + out[1] ** 2 + out[2] ** 2 + out[3] ** 2);
            for (let i = 0; i < 4; i++) out[i] /= len;
            return out;
        }

        const theta = Math.acos(Math.min(1, dot));
        const sin0 = Math.sin(theta);
        const w0 = Math.sin((1 - t) * theta) / sin0;
        const w1 = Math.sin(t * theta) / sin0;
        return [
            a[0] * w0 + b2[0] * w1, a[1] * w0 + b2[1] * w1,
            a[2] * w0 + b2[2] * w1, a[3] * w0 + b2[3] * w1,
        ];
    }
}