// core/world/water/RiverFieldService.js
//
// Bakes the river field (riverField.js) for the traced rivers near the
// camera and publishes it to the GPU (riverField.wgsl.js): a hash table of
// pages, their texels and the parameters, bound in the terrain generator's
// group 1, the carved hydrology sampler, the near water and the terrain shading.
// Tiles touching changed pages regenerate (onChanged: water grid cells).

import { Logger } from '../../../shared/Logger.js';
import { dirToCell } from '../hydrology/waterGraph.js';
import { riverWaterLevels } from './riverMouth.js';
import { fieldDir, finishRiverFieldBake, pageOf, prepareRiverFieldBake, riverFieldLakeCandidates, riverFieldLayout, riverFieldPageFacts, RIVER_FIELD, RIVER_FIELD_WORDS } from './riverField.js';
import { buildRiverFieldTable, riverFieldParamsData, RIVER_FIELD_PARAMS_BYTES } from './riverField.wgsl.js';

// The lake pass runs on the main thread (it needs the masks): at most this long (ms) per task.
const LAKE_SLICE_MS = 3;

export const RIVER_FIELD_SERVICE_DEFAULTS = Object.freeze({
    // Rivers whose nearest point is this close to the camera are baked.
    radiusM: 6000,
    // Bake again when the camera has moved this far.
    moveM: 1500,
    // At most one bake per this long (ms) while rivers keep arriving.
    minIntervalMs: 3000,
    // Baked rivers stay until this many radii away.
    keepScale: 1.4,
});

export class RiverFieldService {
    constructor({ water, service, terrainGenerator, config = {}, onChanged }) {
        this.water = water; this.service = service; this.generator = terrainGenerator;
        this.config = { ...RIVER_FIELD_SERVICE_DEFAULTS, ...config };
        this.onChanged = onChanged;
        this.device = water.device;
        this.layout = riverFieldLayout(water.R);
        this.busy = false; this.isIdle = false; this.disposed = false;
        this.revision = -1; this.bakedAt = null; this.rivers = new Map();
        this.pages = new Map();
        this.stats = null; this.retired = [];
        this.resources = null;
        // The bake's CPU part runs in a module worker (in-process without one).
        this._worker = null; this._calls = new Map(); this._nextId = 1;
        this._startWorker();
        this._publish(new Map());
    }

    _startWorker() {
        try {
            this._worker = new Worker(new URL('./riverFieldWorker.js', import.meta.url), { type: 'module' });
            this._worker.onmessage = (e) => {
                if (e.data.progress) { (this.workerLog ??= []).push(e.data.progress); if (this.workerLog.length > 80) this.workerLog.shift(); return; }
                const call = this._calls.get(e.data.id);
                if (!call) return;
                this._calls.delete(e.data.id);
                if (e.data.error) call.reject(new Error(e.data.error)); else call.resolve(e.data.reply);
            };
            // A crashed worker (e.g. out of memory) rejects its bakes instead of leaving them pending.
            const fail = (e) => {
                const message = e?.message || 'river field worker failed';
                Logger.warn(`[Water] river field worker: ${message}`);
                for (const call of this._calls.values()) call.reject(new Error(message));
                this._calls.clear();
            };
            this._worker.onerror = fail;
            this._worker.onmessageerror = fail;
        } catch (error) { Logger.warn(`[Water] river field worker unavailable (${error?.message || error}); baking in-process`); }
    }

    // A call to the worker; transfer: buffers it takes over.
    _call(msg, transfer) {
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            // A bake that runs away (60 s) restarts the worker instead of
            // leaving the field busy for good.
            const timer = setTimeout(() => {
                if (!this._calls.has(id)) return;
                this._calls.delete(id);
                this._worker.terminate();
                this._startWorker();
                reject(new Error('river field bake timed out'));
            }, 60000);
            this._calls.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
            this._worker.postMessage({ id, msg }, transfer);
        });
    }

    _prepare(rivers) {
        return this._worker ? this._call({ prepare: true, rivers, L: this.layout }, []) : prepareRiverFieldBake({ rivers, L: this.layout });
    }

    async _finish(msg) {
        if (!this._worker) {
            const { pages, stats } = finishRiverFieldBake(msg);
            return { pages, stats, facts: riverFieldPageFacts([...pages.keys()], pages, this.layout) };
        }
        const reply = await this._call(msg, [msg.dirs4.buffer, msg.nat.buffer, msg.lakeCand.buffer]);
        const pages = new Map();
        reply.keys.forEach((k, i) => pages.set(k, reply.data.subarray(i * reply.size, (i + 1) * reply.size)));
        // The pages in key order, one array: uploaded as is (no 100 MB copy).
        pages.packed = reply.data;
        return { pages, stats: reply.stats, facts: { hash: reply.hash, wet: reply.wet } };
    }

    // Traced rivers with a point within the radius of the camera (all of
    // them: the old GPU segment lists' capacity does not decide).
    _nearRivers(cameraDir) {
        const w = this.water, out = [], cosIn = Math.cos(this.config.radiusM / w.R), cosOut = Math.cos(this.config.radiusM * this.config.keepScale / w.R);
        for (const [rid, rec] of w._appliedRivers) {
            const P = rec.points, st = rec.stride, n = P.length / st;
            // Degenerate traces (river 2587: two identical points) shape nothing.
            if (n < 2 || !(w._arcLengths(rec)[n - 1] >= 4)) continue;
            // A baked river stays until keepScale x the radius: at the edge it
            // would flip in and out, regenerating its tiles each time.
            const cosR = this.rivers.get(rid) === rec ? cosOut : cosIn;
            for (let k = 0; k < n; k++) {
                if (P[k * st] * cameraDir[0] + P[k * st + 1] * cameraDir[1] + P[k * st + 2] * cameraDir[2] > cosR) { out.push([rid, rec]); break; }
            }
        }
        return out;
    }

    _riverInputs(near) {
        const w = this.water;
        return near.map(([rid, rec]) => {
            const arc = w._arcLengths(rec);
            const levels = riverWaterLevels(rec, arc, d => w.lakeAt(d));
            let srcLevel, destLevel;
            for (const m of rec.mouths ?? []) {
                if (m.sign < 0) srcLevel = m.level; else destLevel = m.level;
            }
            return { rec, arc, rid, levels, srcLevel, destLevel };
        });
    }

    /**
     * True once every river within the radius of the camera is traced (or
     * failed) and the field is baked for them: the loading screen waits for
     * it (startup is the place for water work; no river pops in after it).
     */
    readyForReveal() {
        const svc = this.service, dir = this._lastDir;
        // Regional water has no terrain sampler: nothing here can be baked.
        if (svc.state === 'ready' && !svc._sampler) return true;
        if (!dir || !this.water._ready || svc.state !== 'ready' || this.busy || !this.bakedAt) return false;
        const now = performance.now();
        if (!this._tracedCheck || now - this._tracedCheck.at > 500) {
            let pending = 0;
            for (const r of svc.rivers ?? []) {
                if (svc.rep(r.fromLake) !== r.fromLake || svc.riverRecs.has(r.id) || svc._failedRivers.has(r.id)) continue;
                if (svc._riverDistance(r.id, dir) <= this.config.radiusM) pending++;
            }
            this._tracedCheck = { at: now, pending };
        }
        return this._tracedCheck.pending === 0 && this.water._appliedVersion === this.revision && this.isIdle;
    }

    update(cameraRel) {
        if (this.disposed) return;
        const w = this.water, len = Math.hypot(cameraRel.x, cameraRel.y, cameraRel.z);
        const dir = [cameraRel.x / len, cameraRel.y / len, cameraRel.z / len];
        this._lastDir = dir;
        if (!w._ready || !this.service._sampler) { this.isIdle = !this.busy; return; }
        if (this.busy) { this.isIdle = false; return; }
        const moved = !this.bakedAt || Math.acos(Math.min(1, dir[0] * this.bakedAt[0] + dir[1] * this.bakedAt[1] + dir[2] * this.bakedAt[2])) * w.R > this.config.moveM;
        if (w._appliedVersion === this.revision && !moved && !this._pending) { this.isIdle = true; return; }
        this.revision = w._appliedVersion;
        const near = this._nearRivers(dir);
        const same = near.length === this.rivers.size && near.every(([rid, rec]) => this.rivers.get(rid) === rec);
        if (same) { this.bakedAt = dir; this._pending = false; this.isIdle = true; return; }
        this._pending = true; this.isIdle = false;
        // Bake once the water service has traced what it is tracing (one bake
        // for a batch of rivers), and the main thread's part at most a fifth
        // of the time while rivers keep arriving.
        if (this.service._busy) return;
        const gap = Math.max(this.config.minIntervalMs, 4 * (this.stats?.ms.main ?? this.stats?.ms.total ?? 0));
        if (this._bakedTime && performance.now() - this._bakedTime < gap) return;
        this._pending = false;
        void this._bake(this._riverInputs(near), dir);
    }

    async _bake(rivers, dir) {
        this.busy = true;
        try {
            const sampler = this.service._sampler, L = this.layout, t0 = performance.now();
            const plain = rivers.map(r => ({ rec: { points: r.rec.points, stride: r.rec.stride, mouths: r.rec.mouths ?? [] },
                arc: r.arc, rid: r.rid, levels: r.levels, srcLevel: r.srcLevel, destLevel: r.destLevel }));
            this.stage = 'prepare';
            const prep = await this._prepare(plain);
            this.stage = `sample ${prep.keys.length} pages`;
            const t1 = performance.now();
            // At most 2^21 directions per dispatch (one 64-wide workgroup each:
            // past 65535 workgroups the dispatch is invalid and never reads back).
            const count = prep.dirs4.length / 4, nat = new Float32Array(count), CHUNK = 1 << 21;
            for (let i = 0; i < count; i += CHUNK) {
                const part = await sampler.sampleDirsNatural(prep.dirs4.subarray(i * 4, Math.min(count, i + CHUNK) * 4));
                if (!part) throw new Error('natural ground unavailable');
                nat.set(part, i);
            }
            const t2 = performance.now();
            this.stage = 'lakes';
            // Between frames, a slice at a time: this needs the lake masks here.
            let slice = performance.now(), busy = 0, longest = 0;
            const pause = async () => {
                const ran = performance.now() - slice;
                if (ran < LAKE_SLICE_MS) return;
                busy += ran; longest = Math.max(longest, ran);
                await new Promise(r => setTimeout(r, 0));
                slice = performance.now();
            };
            const lakeCand = await riverFieldLakeCandidates({ rivers, dirs4: prep.dirs4, nat, lakeAt: d => this.water.lakeEdgeAt(d), pause });
            this.stage = 'worker';
            const t3 = performance.now();
            const result = await this._finish({ rivers: plain, L, keys: prep.keys, pageRivers: prep.pageRivers, dirs4: prep.dirs4, nat, lakeCand });
            if (this.disposed) return;
            this.stage = 'publish';
            const t4 = performance.now();
            const hashes = this._hashes;
            this._publish(result.pages, result.facts);
            this.rivers = new Map(rivers.map(r => [r.rid, r.rec]));
            // Pages that changed: new, gone or different.
            const changed = [];
            for (const [key, hash] of this._hashes) if (hashes.get(key) !== hash) changed.push(key);
            for (const key of hashes.keys()) if (!this._hashes.has(key)) changed.push(key);
            this.onChanged?.(this._cellsOf(changed));
            // Main-thread time (the rest ran in the worker): longest, the longest stretch without a frame.
            const publish = performance.now() - t4;
            result.stats.ms = { ...result.stats.ms, dirs: t1 - t0, sample: t2 - t1, lakes: t3 - t2, publish, main: busy + publish, longest: Math.max(longest, publish), total: performance.now() - t0 };
            this.bakedAt = dir; this.stats = result.stats;
            (this.history ??= []).push({ at: Math.round(performance.now()), rivers: rivers.length, ...result.stats.ms, pages: result.stats.pages });
            if (this.history.length > 40) this.history.shift();
            Logger.info(`[Water] river field: ${rivers.length} rivers, ${result.stats.pages} pages (${changed.length} changed), ` +
                `${result.stats.ms.total.toFixed(0)} ms (main ${result.stats.ms.main.toFixed(0)}, worker ${result.stats.ms.finish.toFixed(0)})`);
        } catch (error) {
            this.lastError = String(error?.message || error);
            Logger.warn(`[Water] river field bake failed: ${error?.stack || error}`);
        } finally { this.busy = false; this.stage = null; this._bakedTime = performance.now(); }
    }

    // Water grid cells a set of pages covers (corners and centre of each).
    _cellsOf(keys) {
        const L = this.layout, N = this.water.N, cells = new Set();
        for (const key of keys) {
            const { face, pi, pj } = pageOf(key, L);
            for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
                cells.add(dirToCell(fieldDir(face, (pi + fx) * L.P, (pj + fy) * L.P, L), N));
            }
        }
        return cells;
    }

    _publish(pages, facts = { hash: new Uint32Array(0), wet: new Uint8Array(0) }) {
        const L = this.layout, device = this.device, keys = [...pages.keys()];
        const { table, size } = buildRiverFieldTable(keys);
        let texels = pages.packed;
        const words = L.TEX * RIVER_FIELD_WORDS;
        if (!texels || texels.length !== keys.length * words || !texels.length) {
            texels = new Uint32Array(Math.max(4, keys.length * words));
            keys.forEach((key, slot) => texels.set(pages.get(key), slot * words));
        }
        if (texels.byteLength > device.limits.maxStorageBufferBindingSize) throw new Error('River field exceeds the GPU storage limit');
        const res = {
            pages: device.createBuffer({ label: 'RiverField-table', size: Math.max(16, table.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
            texels: device.createBuffer({ label: 'RiverField-texels', size: texels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
            params: device.createBuffer({ label: 'RiverField-params', size: RIVER_FIELD_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        };
        device.queue.writeBuffer(res.pages, 0, table);
        device.queue.writeBuffer(res.texels, 0, texels);
        const params = riverFieldParamsData(L, size, keys.length > 0, RIVER_FIELD.sdfM);
        device.queue.writeBuffer(res.params, 0, params);
        // Pages with water (the near water draws them): face, pi, pj, slot and centre.
        const wet = [], hashes = new Map();
        keys.forEach((key, slot) => {
            hashes.set(key, facts.hash[slot]);
            if (!facts.wet[slot]) return;
            const { face, pi, pj } = pageOf(key, L);
            wet.push({ face, pi, pj, slot, dir: fieldDir(face, (pi + 0.5) * L.P, (pj + 0.5) * L.P, L) });
        });
        this._hashes = hashes; this.wetPages = wet; this.paramsData = new Float32Array(params); this.version = (this.version ?? 0) + 1;
        if (this.resources) this.retired.push(this.resources);
        this.resources = res; this.pages = pages;
        this.bytes = texels.byteLength + table.byteLength;
        this.generator.setRiverFieldResources(res);
        this.service.setRiverFieldResources?.(res);
        this._retire();
    }

    _retire() {
        const retired = this.retired.splice(0);
        if (!retired.length) return;
        this.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => {
            for (const r of retired) { r.pages.destroy(); r.texels.destroy(); r.params.destroy(); }
        });
    }

    summary() {
        return { busy: this.busy, idle: this.isIdle, rivers: this.rivers.size, pages: this.pages.size, bytes: this.bytes, stats: this.stats, history: this.history };
    }

    dispose() {
        this.disposed = true;
        this._worker?.terminate(); this._worker = null;
        if (this.resources) { this.retired.push(this.resources); this.resources = null; }
        this._retire();
    }
}
