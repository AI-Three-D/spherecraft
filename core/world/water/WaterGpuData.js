// core/world/water/WaterGpuData.js
//
// GPU copy of the lakes and rivers for shaders (layout: waterWgsl.js), kept
// in sync with a WaterService:
// - index, two halves of 6 x N x N u32: (1) two lake slots per grid cell +
//   the graph-river debug bit; a lake first covers its graph cells, once
//   refined the cells under its 16 m mask; (2) per cell, the traced river
//   segments listed in it (first << 8 | count). Uploads only changed rows;
// - river segments: rebuilt whenever traced rivers change (48 bytes each,
//   a segment repeated in every cell its water can reach);
// - lake table: level, mask layer, tangent-plane frame (whole table per
//   change, 64 bytes a lake);
// - mask atlas: r8 layers of maskLayerSize^2, one per refined lake (max-
//   pooled when the lake's mask is larger); when full, the lake farthest
//   from the camera gives its layer up and falls back to level-only;
// - params uniform: switches and look, written every frame (time).

import { LAKE_PARAMS_FLOATS, LAKE_RECORD_FLOATS, RIVER_MAX_SEGS_PER_CELL, RIVER_SEG_FLOATS, RIVER_SUB } from './waterWgsl.js';
import { dirToCell } from '../hydrology/waterGraph.js';
import { planeToDir, tangentBasis } from '../hydrology/lakeRefine.js';

export const WATER_LOOK_DEFAULTS = Object.freeze({
    deepColor: [0.02, 0.10, 0.09],    // albedo of deep water (lit by sky + sun); Whitewater's water tint
    reflection: 1.4,                  // sky reflection strength (x sky radiance)
    absorption: [1.6, 0.8, 0.6],      // per metre of water path (r, g, b); Whitewater's
    rippleFadeM: 800,                 // ripples fade out by this camera distance
    shoreSoftM: 0.15,                 // waterline fade-in depth
    // Rivers (waterWgsl.js waterRiverColor): animated out to riverAnimNearM,
    // plain colour from riverAnimFarM; foam gain on the steepness hint.
    riverAnimNearM: 1500,
    riverAnimFarM: 3000,
    riverFoamGain: 1.0,
});

const SLOT_MASK = 0x7fff;
const RIVER_BIT = 1 << 30;

export class WaterGpuData {
    /**
     * @param {GPUDevice} device
     * @param {object} o  gridN, planetRadius, maxLakes, maskLayerSize, maxMaskLayers
     */
    constructor(device, { gridN = 512, planetRadius, maxLakes = 8192, maskLayerSize = 512, maxMaskLayers = 96, maxRiverSegs = 262144, maxRiverCells = 65536, carve = null } = {}) {
        this.device = device;
        this.N = gridN;
        this.R = planetRadius;
        this.maxLakes = maxLakes;
        this.S = maskLayerSize;
        this.maxLayers = maxMaskLayers;
        this.enabled = true;
        this.debugMode = 0;
        // Active simulation strip { river, s0, s1, halfM, endFadeM, sideFadeM,
        // fade } (WaterRiverSim coverage) or null: the terrain shader hides
        // static water under it (waterSimCover).
        this.site = null;
        this.look = { ...WATER_LOOK_DEFAULTS };
        // River carve parameters (WaterService config.carve; riverCarve.wgsl.js), or null: no carve.
        this.carve = carve;

        const cells = 6 * gridN * gridN;
        const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
        // COPY_SRC: readable for checks (terrain-lab/lake-gpu-run.mjs).
        this.cells = cells;
        // Two halves of one u32 per cell, then a sub-list block per river cell (waterWgsl.js).
        this.subPerCell = RIVER_SUB * RIVER_SUB;
        this.maxRiverCells = maxRiverCells;
        const indexLen = 2 * cells + maxRiverCells * this.subPerCell;
        this.indexBuffer = device.createBuffer({ label: 'Water-index', size: indexLen * 4, usage: S | GPUBufferUsage.COPY_SRC });
        this.maxRiverSegs = maxRiverSegs;
        this.riversBuffer = device.createBuffer({ label: 'Water-rivers', size: maxRiverSegs * RIVER_SEG_FLOATS * 4, usage: S | GPUBufferUsage.COPY_SRC });
        this.lakesBuffer = device.createBuffer({ label: 'Lake-table', size: maxLakes * LAKE_RECORD_FLOATS * 4, usage: S });
        this.paramsBuffer = device.createBuffer({ label: 'Lake-params', size: LAKE_PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.masksTexture = device.createTexture({
            label: 'Lake-masks', size: [maskLayerSize, maskLayerSize, maxMaskLayers], format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.masksView = this.masksTexture.createView({ dimension: '2d-array' });

        this.index = new Uint32Array(indexLen);
        this._segs = new Float32Array(maxRiverSegs * RIVER_SEG_FLOATS);
        this._appliedRivers = new Map(); // riverId -> traced record in the index
        this._riverCells = new Set();    // cells that list river segments
        this._changedCells = new Set();  // cells whose rivers changed (takeChangedCells)
        this.riverSegCount = 0;
        this._table = new Float32Array(maxLakes * LAKE_RECORD_FLOATS);
        this._tableI32 = new Int32Array(this._table.buffer);
        this._params = new ArrayBuffer(LAKE_PARAMS_FLOATS * 4);
        this._ready = false;
        this._appliedVersion = -1;
        this._applied = new Map();     // lakeId -> refined record already in the index
        this._layerOf = new Map();     // lakeId -> mask layer
        this._layerOwner = new Array(maxMaskLayers).fill(-1);
        this._dirtyRows = new Set();   // face * N + j
        this.lakeCount = 0;
    }

    /** True when a lake or a traced river is listed in a grid cell within radiusM of dir (9 probes). */
    hasWaterNear(dir, radiusM) {
        if (!this._ready) return false;
        const frame = { c: dir, ...tangentBasis(dir) };
        for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const c = dirToCell(planeToDir(a * radiusM, b * radiusM, frame, this.R), this.N);
            if ((this.index[c] & SLOT_MASK) || this.index[this.cells + c]) return true;
        }
        return false;
    }

    /**
     * Grid cells whose rivers changed since the last call (the terrain
     * carve differs there: tiles touching them are stale), or null.
     */
    takeChangedCells() {
        if (!this._changedCells.size) return null;
        const cells = this._changedCells;
        this._changedCells = new Set();
        return cells;
    }

    /** Resources for a bind group (see waterWgsl.js WATER_BINDINGS). */
    get resources() {
        return { index: this.indexBuffer, lakes: this.lakesBuffer, masks: this.masksView, params: this.paramsBuffer, rivers: this.riversBuffer };
    }

    _setSlot(cell, slot) {
        const e = this.index[cell];
        const a = e & SLOT_MASK, b = (e >>> 15) & SLOT_MASK;
        if (a === slot || b === slot) return;
        if (a === 0) this.index[cell] = (e & ~SLOT_MASK) | slot;
        else if (b === 0) this.index[cell] = (e & ~(SLOT_MASK << 15)) | (slot << 15);
        else return; // a third lake in one cell: rare, dropped
        this._dirtyRows.add(Math.floor(cell / this.N));
    }

    _clearSlot(cell, slot) {
        const e = this.index[cell];
        let a = e & SLOT_MASK, b = (e >>> 15) & SLOT_MASK;
        if (a !== slot && b !== slot) return;
        if (a === slot) { a = b; b = 0; } else b = 0;
        this.index[cell] = (e & RIVER_BIT) | a | (b << 15);
        this._dirtyRows.add(Math.floor(cell / this.N));
    }

    _lakeCellsOf(svc, id) {
        return svc.lakeCells.subarray(svc.lakeCellStart[id], svc.lakeCellStart[id + 1]);
    }

    /** Removes a lake from the index (its mask cells once refined, else its graph cells) and frees its layer. */
    _unapply(svc, id) {
        const rec = this._applied.get(id);
        for (const c of rec ? rec.maskCells : this._lakeCellsOf(svc, id)) this._clearSlot(c, id + 1);
        this._applied.delete(id);
        const layer = this._layerOf.get(id);
        if (layer !== undefined) { this._layerOwner[layer] = -1; this._layerOf.delete(id); }
    }

    _buildInitialIndex(svc) {
        this.index.fill(0);
        for (let c = 0; c < this.cells; c++) if (svc.riverOf[c] >= 0) this.index[c] |= RIVER_BIT;
        for (const lake of svc.lakes) {
            const slot = svc.rep(lake.id) + 1;
            for (const c of this._lakeCellsOf(svc, lake.id)) this._setSlot(c, slot);
        }
        this.device.queue.writeBuffer(this.indexBuffer, 0, this.index);
        this._dirtyRows.clear();
        this.lakeCount = svc.lakes.length;
    }

    _flushRows() {
        if (!this._dirtyRows.size) return;
        const rows = [...this._dirtyRows].sort((x, y) => x - y);
        // Contiguous row runs, one upload each.
        let start = rows[0], prev = rows[0];
        const flush = (r0, r1) => {
            const off = r0 * this.N, len = (r1 - r0 + 1) * this.N;
            this.device.queue.writeBuffer(this.indexBuffer, off * 4, this.index, off, len);
        };
        for (let k = 1; k < rows.length; k++) {
            if (rows[k] !== prev + 1) { flush(start, prev); start = rows[k]; }
            prev = rows[k];
        }
        flush(start, prev);
        this._dirtyRows.clear();
    }

    _distanceTo(svc, id, camDir) {
        const c = svc.lakes[id].frame.c;
        return Math.acos(Math.max(-1, Math.min(1, camDir[0] * c[0] + camDir[1] * c[1] + camDir[2] * c[2])));
    }

    _allocLayer(svc, id, camDir) {
        let layer = this._layerOwner.indexOf(-1);
        if (layer < 0) {
            // Evict the farthest lake that has a layer (if it is farther than this one).
            let far = -1, farD = this._distanceTo(svc, id, camDir);
            for (let l = 0; l < this.maxLayers; l++) {
                const d = this._distanceTo(svc, this._layerOwner[l], camDir);
                if (d > farD) { farD = d; far = l; }
            }
            if (far < 0) return -1;
            this._layerOf.delete(this._layerOwner[far]);
            layer = far;
        }
        this._layerOwner[layer] = id;
        this._layerOf.set(id, layer);
        return layer;
    }

    _uploadMask(rec, layer) {
        const { nx, ny } = rec.frame, S = this.S;
        const out = new Uint8Array(S * S);
        for (let b = 0; b < S; b++) {
            const j0 = Math.floor(b * ny / S), j1 = Math.max(j0 + 1, Math.floor((b + 1) * ny / S));
            for (let a = 0; a < S; a++) {
                const i0 = Math.floor(a * nx / S), i1 = Math.max(i0 + 1, Math.floor((a + 1) * nx / S));
                let v = 0;
                for (let j = j0; j < j1 && !v; j++) for (let i = i0; i < i1; i++) if (rec.mask[j * nx + i]) { v = 255; break; }
                out[b * S + a] = v;
            }
        }
        this.device.queue.writeTexture({ texture: this.masksTexture, origin: { x: 0, y: 0, z: layer } }, out,
            { bytesPerRow: S, rowsPerImage: S }, { width: S, height: S, depthOrArrayLayers: 1 });
    }

    _writeTable(svc) {
        const t = this._table, ti = this._tableI32, F = LAKE_RECORD_FLOATS;
        for (const lake of svc.lakes) {
            const id = lake.id;
            if (id >= this.maxLakes) break;
            const o = id * F;
            const rec = this._applied.get(id);
            const fr = rec?.frame ?? lake.frame;
            t[o] = rec?.level ?? lake.level;
            ti[o + 1] = rec ? (this._layerOf.get(id) ?? -1) : -1;
            t[o + 2] = fr.nx * fr.spacing; t[o + 3] = fr.ny * fr.spacing;
            t.set([fr.c[0], fr.c[1], fr.c[2], fr.x0], o + 4);
            t.set([fr.e1[0], fr.e1[1], fr.e1[2], fr.y0], o + 8);
            t.set([fr.e2[0], fr.e2[1], fr.e2[2], 0], o + 12);
        }
        const n = Math.min(svc.lakes.length, this.maxLakes) * F;
        this.device.queue.writeBuffer(this.lakesBuffer, 0, t, 0, n);
    }

    /**
     * Per frame. Syncs lake data when the service changed and writes params.
     * @param {object} svc            WaterService
     * @param {{x,y,z}} cameraPos     world position (planet centred at origin)
     * @param {number} time           seconds
     */
    update(svc, cameraPos, time = 0) {
        if (svc?.state === 'ready' && svc.lakeCells) {
            if (!this._ready) { this._buildInitialIndex(svc); this._ready = true; }
            if (svc.version !== this._appliedVersion) {
                const l = Math.hypot(cameraPos.x, cameraPos.y, cameraPos.z) || 1;
                const camDir = [cameraPos.x / l, cameraPos.y / l, cameraPos.z / l];
                for (const [id, rec] of svc.refined) {
                    if (this._applied.get(id) === rec || !rec.maskCells) continue;
                    // The lake's old footprint, and those of lakes merged into it,
                    // give way to the cells under its mask.
                    this._unapply(svc, id);
                    for (const m of rec.merged ?? []) this._unapply(svc, m);
                    for (const c of rec.maskCells) this._setSlot(c, id + 1);
                    const layer = this._allocLayer(svc, id, camDir);
                    if (layer >= 0) this._uploadMask(rec, layer);
                    this._applied.set(id, rec);
                }
                let riversChanged = false;
                for (const [rid, rec] of svc.riverRecs ?? []) {
                    if (this._appliedRivers.get(rid) === rec) continue;
                    // The traced river replaces its graph cells in the debug view.
                    for (const c of svc.rivers[rid].cells) {
                        if (svc.riverOf[c] === rid && (this.index[c] & RIVER_BIT)) { this.index[c] &= ~RIVER_BIT; this._dirtyRows.add(Math.floor(c / this.N)); }
                    }
                    // The terrain carve changes in the cells of the old and the new trace.
                    for (const old of [this._appliedRivers.get(rid), rec]) {
                        if (old?.segCells) for (const id of old.segCells) this._changedCells.add(Math.floor(id / this.subPerCell));
                    }
                    this._appliedRivers.set(rid, rec);
                    riversChanged = true;
                }
                if (riversChanged) this._rebuildRivers(camDir);
                this._flushRows();
                this._writeTable(svc);
                this._appliedVersion = svc.version;
            }
        }
        const p = this._params, u = new Uint32Array(p), f = new Float32Array(p), L = this.look;
        u[0] = this.N; u[1] = this.enabled && this._ready ? 1 : 0; u[2] = this.debugMode >>> 0; u[3] = this._appliedRivers.size;
        f[4] = this.R; f[5] = time; f[6] = L.rippleFadeM; f[7] = L.shoreSoftM;
        f.set([L.deepColor[0], L.deepColor[1], L.deepColor[2], L.reflection], 8);
        f.set([L.absorption[0], L.absorption[1], L.absorption[2], 0], 12);
        const site = this.site;
        if (site && site.fade > 0) {
            f.set([site.river, site.s0, site.s1, site.halfM], 16);
            f.set([site.endFadeM, site.sideFadeM, 0, site.fade], 20);
        } else {
            f.fill(0, 16, 24);
        }
        f.set([L.riverAnimNearM ?? 1500, L.riverAnimFarM ?? 3000, L.riverFoamGain ?? 1, 0], 24);
        // River cross-section (waterWgsl.js WaterParams.carve / .bank). The
        // shading uses it too, so it is set even with the carve off.
        const C = this.carve ?? {};
        f.set([C.enabled ? 1 : 0, C.bankW ?? 12, C.blendW ?? 30, C.waterFrac ?? 0.75], 28);
        f.set([C.bankH ?? 1.5, C.bankSoftM ?? 3, C.bankGrade ?? 0.06, 0], 32);
        f.set([C.poolFadeM ?? 30, C.floodGrade ?? 0.01, 0, 0], 36);
        this.device.queue.writeBuffer(this.paramsBuffer, 0, p);
    }

    /**
     * Lays out every traced river's segments per sub-cell (rec.segCells:
     * cell * SUB^2 + sub, waterGraph.js dirToCellSub): a block of sub-lists
     * per river cell (index half 2 points at it), and uploads them. Nearest
     * rivers first when the buffers are full.
     */
    _rebuildRivers(camDir) {
        const F = RIVER_SEG_FLOATS, SS = this.subPerCell, lists = new Map();
        const recs = [...this._appliedRivers.entries()].map(([rid, rec]) => {
            const P = rec.points;
            const cosA = camDir[0] * P[0] + camDir[1] * P[1] + camDir[2] * P[2];
            return { rid, rec, far: -cosA };
        }).sort((a, b) => a.far - b.far);
        const ridOf = new Map(recs.map(r => [r.rec, r.rid]));
        let total = 0, dropped = 0;
        for (const { rec } of recs) {
            const n = rec.points.length / rec.stride;
            const need = rec.segCells.length;
            if (total + need > this.maxRiverSegs) { dropped++; continue; }
            total += need;
            for (let k = 0; k + 1 < n; k++) {
                for (let m = rec.segCellStart[k]; m < rec.segCellStart[k + 1]; m++) {
                    const c = rec.segCells[m];
                    let list = lists.get(c);
                    if (!list) lists.set(c, (list = []));
                    if (list.length < RIVER_MAX_SEGS_PER_CELL) list.push(rec, k);
                }
            }
        }
        const subs = [...lists.keys()].sort((a, b) => a - b);
        const blockOf = new Map();   // river cell -> block
        let next = 0, full = 0;
        for (const id of subs) {
            const c = Math.floor(id / SS);
            let block = blockOf.get(c);
            if (block === undefined) {
                if (blockOf.size >= this.maxRiverCells) { full++; continue; }
                block = blockOf.size;
                blockOf.set(c, block);
                const b0 = 2 * this.cells + block * SS;
                this.index.fill(0, b0, b0 + SS);
            }
            const list = lists.get(id), first = next;
            for (let m = 0; m < list.length; m += 2) {
                const rec = list[m], k = list[m + 1], P = rec.points, st = rec.stride, a = k * st, b = (k + 1) * st, o = next * F;
                const arc = this._arcLengths(rec);
                // WaterRiverSeg (waterWgsl.js): p0, eta0, p1, eta1, hw, thalweg,
                // pool, skew, speed, foam, arc length at both ends, river id
                // (points: waterWorkerCore.js).
                const ext = st >= 12;
                this._segs.set([P[a], P[a + 1], P[a + 2], P[a + 3], P[b], P[b + 1], P[b + 2], P[b + 3],
                    P[a + 4], P[b + 4], P[a + 3] - P[a + 5], P[b + 3] - P[b + 5],
                    ext ? P[a + 9] : 0, ext ? P[b + 9] : 0, ext ? P[a + 10] : 0, ext ? P[b + 10] : 0,
                    P[a + 6], P[b + 6], ext ? P[a + 11] : 0, ext ? P[b + 11] : 0,
                    arc[k], arc[k + 1], ridOf.get(rec) ?? -1, 0], o);
                next++;
            }
            this.index[2 * this.cells + block * SS + (id % SS)] = (first << 8) | (list.length / 2);
        }
        for (const [c, block] of blockOf) {
            const idx = this.cells + c;
            if (this.index[idx] !== block + 1) { this.index[idx] = block + 1; this._dirtyRows.add(Math.floor(idx / this.N)); }
        }
        for (const c of this._riverCells) {
            if (blockOf.has(c)) continue;
            const idx = this.cells + c;
            this.index[idx] = 0; this._dirtyRows.add(Math.floor(idx / this.N));
        }
        // The used blocks, whole rows.
        const b0 = 2 * this.cells, b1 = b0 + blockOf.size * SS;
        for (let r = Math.floor(b0 / this.N); r * this.N < b1; r++) this._dirtyRows.add(r);
        this._riverCells = new Set(blockOf.keys());
        if (full) console.warn(`[Water] river cell blocks full: ${full} sub-cells not listed`);
        if (next) this.device.queue.writeBuffer(this.riversBuffer, 0, this._segs, 0, next * F);
        this.riverSegCount = next;
        if (dropped) console.warn(`[Water] river segment buffer full: ${dropped} far rivers not drawn`);
    }

    /** Arc length (m) of each point of a traced river (cached per record). */
    _arcLengths(rec) {
        this._arcCache ??= new WeakMap();
        let arc = this._arcCache.get(rec);
        if (arc) return arc;
        const P = rec.points, st = rec.stride, n = P.length / st;
        arc = new Float64Array(n);
        for (let k = 1; k < n; k++) {
            arc[k] = arc[k - 1] + Math.hypot(P[k * st] - P[(k - 1) * st], P[k * st + 1] - P[(k - 1) * st + 1], P[k * st + 2] - P[(k - 1) * st + 2]) * this.R;
        }
        this._arcCache.set(rec, arc);
        return arc;
    }

    destroy() {
        this.indexBuffer.destroy(); this.lakesBuffer.destroy(); this.paramsBuffer.destroy(); this.masksTexture.destroy(); this.riversBuffer.destroy();
    }
}

/**
 * Predicate (face, depth, x, y) for quadtree tiles touching any of the grid
 * cells (water graph cube grid, N per face side) or within marginCells of
 * one (tile normals read a border beyond the tile). Tile x, y index face U,
 * V at 2^depth tiles per side, as the cells do at N.
 */
export function tilesTouchingCells(cells, N, marginCells = 1) {
    const byFace = new Map();
    for (const c of cells) {
        const face = Math.floor(c / (N * N)), r = c % (N * N);
        let list = byFace.get(face);
        if (!list) byFace.set(face, (list = []));
        list.push(r);
    }
    const sets = new Map([...byFace].map(([f, list]) => [f, new Set(list)]));
    return (face, depth, x, y) => {
        const list = byFace.get(face);
        if (!list) return false;
        const g = 2 ** depth;
        const i0 = Math.max(0, Math.floor((x / g) * N) - marginCells), i1 = Math.min(N - 1, Math.ceil(((x + 1) / g) * N) - 1 + marginCells);
        const j0 = Math.max(0, Math.floor((y / g) * N) - marginCells), j1 = Math.min(N - 1, Math.ceil(((y + 1) / g) * N) - 1 + marginCells);
        if ((i1 - i0 + 1) * (j1 - j0 + 1) <= list.length) {
            const set = sets.get(face);
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (set.has(j * N + i)) return true;
            return false;
        }
        return list.some(r => { const i = r % N, j = Math.floor(r / N); return i >= i0 && i <= i1 && j >= j0 && j <= j1; });
    };
}
