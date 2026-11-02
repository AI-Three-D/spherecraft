// Page-side probe: who claims the water at each point of a plan-view grid
// ahead of the camera. Per cell: carved ground (terrain sampler, junction
// fields included, no micro detail), the river surface (waterRiverSurfaceAt:
// level, half-width, distance), the lake (waterLakeHitView, as drawn: with
// give-way) and the junction field (level, influence, basin distance).
// Grid: x forward along the camera's horizontal look, y to its left.
// Caveat (2026-11-02): the ground here is the hydrology sampler's carved
// terrain; at the hillside mouth it did not show the junction field's
// shaping that the tiles draw (field on/off gave the same map while the
// captures differed). Near mouths, confirm with a capture A/B.
import { createWaterWgsl, WATER_BINDINGS } from '../../../core/world/water/waterWgsl.js';
import { junctionFieldLookupWgsl } from '../../../core/world/water/junctionField.wgsl.js';

const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

// river: { id, sign }: the grid follows that river instead, x = arc length
// from its mouth station (lakeward positive), y = offset to the left of
// the traced line (riverMouth.js riverMouths).
export async function mouthOutline({ fieldInfluence = false, view = null, river = null, x0 = 20, x1 = 260, halfY = 90, stepM = 2, printStepM = 4, rows = null } = {}) {
    const g = window.gameEngine, w = g.waterGpuData, R = w.R, device = w.device;
    if (view) await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const nx = Math.round((x1 - x0) / stepM) + 1, ny = Math.round(2 * halfY / stepM) + 1, n = nx * ny;
    const dirs = new Float32Array(n * 4);
    let mouth = null;
    if (river) {
        const rec = g.waterService.riverRecs.get(river.id), P = rec.points, st = rec.stride, arc = w._arcLengths(rec);
        const { riverMouths } = await import('/core/world/water/riverMouth.js');
        mouth = riverMouths(rec, arc).find(m => m.sign === river.sign);
        if (!mouth) return { error: 'no mouth', mouths: riverMouths(rec, arc) };
        const at = k => Array.from(P.subarray(k * st, k * st + 3)), last = arc.length - 1;
        for (let i = 0; i < nx; i++) {
            const a = mouth.s + (x0 + i * stepM) * mouth.sign;
            let k = 0; while (k + 1 < last && arc[k + 1] < a) k++;
            const t = (a - arc[k]) / Math.max(0.001, arc[k + 1] - arc[k]);
            const A = at(k), B = at(k + 1), d = norm(A.map((v, j) => v + (B[j] - v) * t));
            const lft = norm(cross(d, B.map((v, j) => (v - A[j]) * mouth.sign)));
            for (let j = 0; j < ny; j++) dirs.set(norm(d.map((v, q) => v + lft[q] * (halfY - j * stepM) / R)), (j * nx + i) * 4);
        }
    } else {
        const o = g.planetConfig.origin || { x: 0, y: 0, z: 0 }, cam = g.camera.position, tgt = g.camera.target;
        const up = norm([cam.x - o.x, cam.y - o.y, cam.z - o.z]);
        const look = [tgt.x - cam.x, tgt.y - cam.y, tgt.z - cam.z];
        const fwd = norm(look.map((v, i) => v - up[i] * look.reduce((a, z, j) => a + z * up[j], 0)));
        const left = cross(up, fwd);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const x = x0 + i * stepM, y = halfY - j * stepM;
            dirs.set(norm(up.map((v, k) => v + (fwd[k] * x + left[k] * y) / R)), (j * nx + i) * 4);
        }
    }
    const ground = await g.waterService._sampler.sampleDirsCarved(dirs);
    const input = new Float32Array(n * 4);
    for (let c = 0; c < n; c++) input.set([dirs[4*c], dirs[4*c+1], dirs[4*c+2], ground[c]], 4 * c);
    const code = createWaterWgsl({ group: 1 }) + junctionFieldLookupWgsl(3) + /* wgsl */`
@group(1) @binding(17) var probeSampler: sampler;
@group(0) @binding(0) var<storage, read> probeIn: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> probeOut: array<vec4<f32>>;
@compute @workgroup_size(64)
fn probeMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&probeIn)) { return; }
    let dir = probeIn[i].xyz; let gr = probeIn[i].w;
    let r = waterRiverSurfaceAt(dir);
    let lk = waterLakeHitView(dir, gr, probeSampler, false, true);
    let jl = junctionLocate(dir); let jv = junctionValue(jl);
    probeOut[3u*i] = vec4<f32>(select(0.0, 1.0, r.near), r.etaM, r.halfWidthM, r.distM);
    probeOut[3u*i+1u] = vec4<f32>(lk.level, lk.cover, lk.insideM, lk.depthM);
    probeOut[3u*i+2u] = vec4<f32>(select(0.0, 1.0, jl.found), jv.x, jv.z, jv.w);
}`;
    const module = device.createShaderModule({ label: 'MouthOutlineProbe', code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length) return { error: errors.map(m => `${m.lineNum}: ${m.message}`).slice(0, 5) };
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'probeMain' } });
    const inBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outBuf = device.createBuffer({ size: n * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: n * 48, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inBuf, 0, input);
    const B = WATER_BINDINGS, res = w.resources, store = g.terrainGenerator.junctionFields;
    const g0 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] });
    const g1 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
        { binding: B.index, resource: { buffer: res.index } }, { binding: B.lakes, resource: { buffer: res.lakes } },
        { binding: B.masks, resource: res.masks }, { binding: B.params, resource: { buffer: res.params } },
        { binding: B.rivers, resource: { buffer: res.rivers } }, { binding: 17, resource: g.terrainGenerator._lakeMaskSampler }] });
    const g3 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(3), entries: store.resources.entries });
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, g0); pass.setBindGroup(1, g1); pass.setBindGroup(3, g3);
    pass.dispatchWorkgroups(Math.ceil(n / 64)); pass.end();
    enc.copyBufferToBuffer(outBuf, 0, read, 0, n * 48);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0)); read.unmap();
    for (const b of [inBuf, outBuf, read]) b.destroy();
    const cell = (i, j) => {
        const c = j * nx + i, q = 12 * c;
        return { ground: ground[c], river: { near: out[q] > 0.5, eta: out[q+1], hw: out[q+2], d: out[q+3] },
            lake: { level: out[q+4], cover: out[q+5], inside: out[q+6] },
            field: { found: out[q+8] > 0.5, level: out[q+9], influence: out[q+10], basin: out[q+11] } };
    };
    // Map: R river surface over ground below it, L lake (cover > 0.5) over
    // ground below its level, B both, r river within its width but ground
    // above its level, . dry. Field: digit = ground above the field's level
    // (dm, 0-9, + more), - below it.
    const every = Math.max(1, Math.round(printStepM / stepM)), map = [], fieldMap = [], levelMap = [];
    for (let j = 0; j < ny; j += every) {
        let a = '', b = '';
        for (let i = 0; i < nx; i += every) {
            const c = cell(i, j), inRiver = c.river.near && c.river.d < c.river.hw;
            const R_ = inRiver && c.ground < c.river.eta, L_ = c.lake.level > -1e9 && c.lake.cover > 0.5 && c.ground < c.lake.level;
            a += R_ && L_ ? 'B' : R_ ? 'R' : L_ ? 'L' : inRiver ? 'r' : '.';
            if (fieldInfluence && c.field.found) b += c.field.influence >= 0.999 ? '#' : c.field.influence > 0 ? String(Math.min(9, Math.floor(c.field.influence * 10))) : '.';
            else if (!c.field.found || c.field.influence < 0.5) b += ' ';
            else { const dz = c.ground - c.field.level; b += dz < 0 ? '-' : dz >= 1 ? '+' : String(Math.floor(dz * 10)); }
        }
        map.push(a); fieldMap.push(b);
        if (mouth) {
            let lv = '';
            for (let i = 0; i < nx; i += every) {
                const dz = ground[j * nx + i] - mouth.level;
                lv += dz < -1 ? '=' : dz < 0 ? '-' : dz >= 1 ? '+' : String(Math.floor(dz * 10));
            }
            levelMap.push(lv);
        }
    }
    const sections = (rows ?? []).map(x => {
        const i = Math.round((x - x0) / stepM);
        return { x, cells: Array.from({ length: Math.ceil(ny / every) }, (_, t) => {
            const j = t * every, c = cell(i, j);
            return [halfY - j * stepM, +c.ground.toFixed(2), c.river.near ? +c.river.eta.toFixed(2) : null, c.river.near ? +c.river.hw.toFixed(1) : null,
                c.river.near ? +c.river.d.toFixed(1) : null, c.lake.level > -1e9 ? +c.lake.level.toFixed(2) : null, +c.lake.cover.toFixed(2),
                c.field.found ? +c.field.level.toFixed(2) : null, c.field.found ? +c.field.basin.toFixed(1) : null];
        }) };
    });
    return { mouth, grid: { x0, x1, halfY, stepM, printStepM: every * stepM }, legend: 'map: R river, L lake, B both, r river width but ground above, . dry | field: ground above field level in dm, - below, + >=1 m',
        rows: map.map((r, t) => r + '   ' + fieldMap[t]), levelRows: levelMap, levelLegend: 'ground vs the mouth level: = >1 m below, - below, digit dm above, + >=1 m above', sectionsLegend: '[y, ground, riverEta, riverHw, riverD, lakeLevel, lakeCover, fieldLevel, basinDist]', sections };
}

// Where screen pixels (canvas CSS pixels of the capture) meet the ground,
// in a river's frame: s from its mouth (lakeward +), offset left of the line.
export async function pixelsToRiver({ pixels, river, maxM = 600, stepM = 0.5 }) {
    const g = window.gameEngine, w = g.waterGpuData, R = w.R, cam = g.camera, o = g.planetConfig.origin || { x: 0, y: 0, z: 0 };
    const c = g.canvas, aspect = c.width / c.height, fov = (cam.fov ?? 75) * Math.PI / 180;
    const P = [cam.position.x - o.x, cam.position.y - o.y, cam.position.z - o.z], T = [cam.target.x - o.x, cam.target.y - o.y, cam.target.z - o.z];
    const f = norm(T.map((v, i) => v - P[i])), up0 = cam.up ? [cam.up.x, cam.up.y, cam.up.z] : norm(P);
    const right = norm(cross(f, up0)), up = cross(right, f), th = Math.tan(fov / 2);
    const cw = c.clientWidth || c.width, ch = c.clientHeight || c.height;
    const rays = pixels.map(([px, py]) => norm(f.map((v, i) => v + right[i] * (2 * px / cw - 1) * th * aspect + up[i] * (1 - 2 * py / ch) * th)));
    const steps = Math.round(maxM / stepM), dirs = new Float32Array(rays.length * steps * 4), radii = [];
    rays.forEach((ray, r) => { for (let k = 0; k < steps; k++) {
        const p = P.map((v, i) => v + ray[i] * k * stepM), len = Math.hypot(...p);
        dirs.set([p[0] / len, p[1] / len, p[2] / len, 0], (r * steps + k) * 4); radii.push(len);
    } });
    const ground = await g.waterService._sampler.sampleDirsCarved(dirs);
    const { riverMouths } = await import('/core/world/water/riverMouth.js');
    // river null: the nearest traced river to each hit, its mouths' stations.
    const recs = river ? [[river.id, g.waterService.riverRecs.get(river.id)]] : [...g.waterService.riverRecs.entries()];
    return rays.map((ray, r) => {
        let k = 0; while (k < steps && radii[r * steps + k] - R > ground[r * steps + k]) k++;
        if (k >= steps) return { pixel: pixels[r], hit: null };
        const d = Array.from(dirs.subarray((r * steps + k) * 4, (r * steps + k) * 4 + 3));
        let best = { dist: Infinity };
        for (const [id, rec] of recs) {
            const RP = rec.points, st = rec.stride, arc = w._arcLengths(rec);
            for (let q = 0; q + 1 < arc.length; q++) {
                const A = Array.from(RP.subarray(q * st, q * st + 3)), B = Array.from(RP.subarray((q + 1) * st, (q + 1) * st + 3));
                const ab = B.map((v, i) => v - A[i]), t = Math.max(0, Math.min(1, d.reduce((a, v, i) => a + (v - A[i]) * ab[i], 0) / ab.reduce((a, v) => a + v * v, 0)));
                const foot = A.map((v, i) => v + ab[i] * t), dist = Math.hypot(...d.map((v, i) => v - foot[i])) * R;
                if (dist < best.dist) {
                    const side = Math.sign(d.reduce((a, v, i) => a + (v - foot[i]) * cross(foot, ab)[i], 0));
                    best = { dist, s: arc[q] + (arc[q + 1] - arc[q]) * t, side, id, q, hw: RP[q * st + 4], level: RP[q * st + 16], length: arc[arc.length - 1], mouths: riverMouths(rec, arc) };
                }
            }
        }
        const m = best.mouths.reduce((a, b) => !a || Math.abs(b.s - best.s) < Math.abs(a.s - best.s) ? b : a, null);
        return { pixel: pixels[r], groundM: +ground[r * steps + k].toFixed(2), rangeM: k * stepM, river: best.id, s: +best.s.toFixed(1), lengthM: +best.length.toFixed(0),
            hw: +best.hw.toFixed(1), level: +best.level.toFixed(2), offsetM: +(best.dist * best.side).toFixed(1),
            mouth: m && { s: +m.s.toFixed(1), sign: m.sign, level: +m.level.toFixed(2), landM: +m.landM.toFixed(0), fromMouthM: +((best.s - m.s) * m.sign).toFixed(1) } };
    });
}
