/**
 * Ground line along a cut plane.
 *
 *  - Inside the region footprint: the captured heightfield, available synchronously.
 *  - Beyond it: heights from the asynchronous query, sampled on a lattice s = i * step anchored to
 *    absolute s (panning does not move samples). step = outsideStep * 2^level follows the zoom.
 *
 * The two sources are NOT welded at the region edge: each run ends on its own source's height at
 * the seam, and `seams` reports both, so a disagreement stays visible and measurable.
 *
 * Async handling: one request in flight per plane state; a plane change starts a new epoch and late
 * results from older epochs are dropped, so arrival order does not matter. Failures are reported,
 * never thrown into the frame loop, and retried after `retryUpdates` updates.
 *
 * @callback QueryHeights
 * @param {Float64Array} positions interleaved frame-local [x0, z0, x1, z1, ...]; read during the call
 * @returns {Promise<ArrayLike<number>>} one height per position, metres along frame up
 */
const LEFT = -1, INSIDE = 0, RIGHT = 1;
const zoneOf = (s, span, eps) => (s < span[0] - eps ? LEFT : s > span[1] + eps ? RIGHT : INSIDE);

export class GroundProfile {
    /**
     * @param {Object} options
     * @param {import('./CapturedHeightfield.js').CapturedHeightfield} options.heightfield
     * @param {import('./CutPlane.js').CutPlane} options.plane
     * @param {QueryHeights | null} [options.queryHeights]
     */
    constructor({ heightfield, plane, queryHeights = null, insideStep = 0.25, outsideStep = 1,
        pixelsPerSample = 4, maxSamples = 8192, retryUpdates = 120, onError = null }) {
        this.heightfield = heightfield;
        this.plane = plane;
        this.queryHeights = queryHeights;
        this.insideStep = insideStep;
        this.outsideStep = outsideStep;
        this.pixelsPerSample = pixelsPerSample;
        this.maxSamples = maxSamples;
        this.retryUpdates = retryUpdates;
        this.onError = onError;

        /** Bumps whenever `runs` or `seams` change. */
        this.revision = 0;
        /** @type {{source: 'captured' | 'queried', points: Float64Array}[]} (s, y) pairs in plane coordinates */
        this.runs = [];
        /** @type {{s: number, captured: number, queried: number | null}[]} region edges along the cut, left then right */
        this.seams = [];
        this.stats = { requests: 0, samples: 0, stale: 0, failures: 0 };
        this.lastError = null;

        this._planeRevision = -1;
        this._epoch = 0;
        this._inFlightEpoch = -1;
        this._span = null;
        this._inside = null;
        this._window = null;
        this._updates = 0;
        this._retryAt = 0;
        this._disposed = false;
    }

    /** Queried minus captured height at each seam (null until the query has answered). */
    get seamResiduals() {
        return this.seams.map(seam => (seam.queried === null ? null : seam.queried - seam.captured));
    }

    /** Forget queried heights (e.g. the terrain changed) and fetch again on the next update. */
    invalidate() { this._planeRevision = -1; }

    dispose() { this._disposed = true; }

    /**
     * Syn­chronous; call once per frame with the visible s-range and zoom. May start one query.
     * @param {number} sMin @param {number} sMax @param {number} metersPerPixel
     */
    update(sMin, sMax, metersPerPixel) {
        if (this._disposed) return;
        if (!(sMax > sMin) || !(metersPerPixel > 0)) throw new RangeError('GroundProfile.update: empty view range');
        this._updates++;
        if (this._planeRevision !== this.plane.revision) this._reset();
        if (!this.queryHeights) return;

        let level = Math.max(0, Math.ceil(Math.log2(metersPerPixel * this.pixelsPerSample / this.outsideStep) - 1e-9));
        while ((sMax - sMin) / (this.outsideStep * 2 ** level) * 2 + 4 > this.maxSamples) level++;
        const step = this.outsideStep * 2 ** level;
        const first = Math.floor(sMin / step), last = Math.ceil(sMax / step);
        const w = this._window;
        const covered = w !== null && w.level === level && w.i0 <= first && w.i1 >= last;
        if (!covered && this._inFlightEpoch !== this._epoch && this._updates >= this._retryAt) {
            const pad = Math.ceil((last - first + 1) / 2);
            this._request(level, step, first - pad, last + pad);
        }
    }

    _reset() {
        const { heightfield: hf, plane } = this;
        this._planeRevision = plane.revision;
        this._epoch++;
        this._window = null;
        this._inside = null;
        this.seams = [];
        const span = plane.clipToRect(hf.minX, hf.minZ, hf.maxX, hf.maxZ);
        this._span = span;
        if (span) {
            const [s0, s1] = span;
            const count = Math.max(1, Math.ceil((s1 - s0) / this.insideStep - 1e-9));
            const points = new Float64Array((count + 1) * 2);
            for (let i = 0; i <= count; i++) {
                const s = i === count ? s1 : s0 + (s1 - s0) * (i / count);
                points[2 * i] = s;
                points[2 * i + 1] = hf.sample(plane.x(s), plane.z(s));
            }
            this._inside = points;
            this.seams = [s0, s1].map(s => ({ s, captured: hf.sample(plane.x(s), plane.z(s)), queried: null }));
        }
        this._rebuildRuns();
    }

    _request(level, step, i0, i1) {
        const { plane, _span: span, _epoch: epoch } = this;
        const eps = step * 1e-6;
        const wanted = [];
        for (let i = i0; i <= i1; i++) if (!span || zoneOf(i * step, span, eps) !== INSIDE) wanted.push(i);
        const seamCount = this.seams.length;
        const total = seamCount + wanted.length;
        const positions = new Float64Array(total * 2);
        let o = 0;
        for (const seam of this.seams) { positions[o++] = plane.x(seam.s); positions[o++] = plane.z(seam.s); }
        for (const i of wanted) { positions[o++] = plane.x(i * step); positions[o++] = plane.z(i * step); }

        this._inFlightEpoch = epoch;
        this.stats.requests++;
        this.stats.samples += total;

        const fail = error => {
            if (this._disposed || epoch !== this._epoch) return;
            this._inFlightEpoch = -1;
            this._retryAt = this._updates + this.retryUpdates;
            this.stats.failures++;
            this.lastError = error;
            try { this.onError?.(error); } catch { /* reporting must not break the frame loop */ }
        };

        let pending;
        try { pending = Promise.resolve(this.queryHeights(positions)); } catch (error) { pending = Promise.reject(error); }
        pending.then(heights => {
            if (this._disposed) return;
            if (epoch !== this._epoch) { this.stats.stale++; return; }
            if (!heights || heights.length !== total) throw new Error(`height query returned ${heights?.length} heights for ${total} positions`);
            for (let k = 0; k < total; k++) if (!Number.isFinite(heights[k])) throw new Error('height query returned a non-finite height');
            this._inFlightEpoch = -1;
            this.seams.forEach((seam, k) => { seam.queried = heights[k]; });
            const values = new Float32Array(i1 - i0 + 1).fill(NaN);
            wanted.forEach((i, k) => { values[i - i0] = heights[seamCount + k]; });
            this._window = { level, step, i0, i1, heights: values };
            this._rebuildRuns();
        }).catch(fail);
    }

    _rebuildRuns() {
        const runs = [];
        if (this._inside) runs.push({ source: 'captured', points: this._inside });
        const w = this._window, span = this._span;
        if (w) {
            const eps = w.step * 1e-6;
            let current = [];
            let previous = null;
            const flush = () => {
                if (current.length >= 4) runs.push({ source: 'queried', points: Float64Array.from(current) });
                current = [];
            };
            const seam = k => {
                const edge = this.seams[k];
                if (edge && edge.queried !== null) current.push(edge.s, edge.queried);
            };
            for (let i = w.i0; i <= w.i1; i++) {
                const s = i * w.step;
                const zone = span ? zoneOf(s, span, eps) : LEFT;
                if (zone !== previous) {
                    if (previous === LEFT) seam(0);                                   // left run ends on the seam
                    flush();
                    if (zone === RIGHT && s - w.step <= span[1] + eps) seam(1);       // right run starts on the seam
                    previous = zone;
                }
                if (zone !== INSIDE) current.push(s, w.heights[i - w.i0]);
            }
            flush();
        }
        this.runs = runs;
        this.revision++;
    }
}