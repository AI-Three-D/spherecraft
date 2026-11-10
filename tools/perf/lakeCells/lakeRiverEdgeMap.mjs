// Top-down map of the baked river field near a place, in Node on the GPU: per
// metre, the field's water (sdf > 0, blue by depth W - carved ground) and dry
// ground (grey by carve depth), to see whether a jagged water's edge is in the
// field itself or only in how it is drawn.
//   LAKE_CAM="x,y,z" LAKE_LOOK="x,y,z" node tools/perf/lakeCells/lakeRiverEdgeMap.mjs out.png  (from spherecraft/)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';
import { writePNG } from '../../../../terrain-lab/png.mjs';

process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { gen, imp, device } = lab;
const { WaterService } = await imp('core/world/hydrology/WaterService.js');
const { WaterGpuData } = await imp('core/world/water/WaterGpuData.js');
const { RiverFieldService } = await imp('core/world/water/RiverFieldService.js');
const { sampleRiverField } = await imp('core/world/water/riverField.js');
const { tangentBasis, planeToDir } = await imp('core/world/hydrology/lakeRefine.js');
const R = lab.planetConfig.radius, out = process.argv[2] ?? 'river-edge.png';
const cam = (process.env.LAKE_CAM ?? '-131927.1,-4484.0,-2912.6').split(',').map(Number);
const look = (process.env.LAKE_LOOK ?? '-131734.1,-4210.1,-2928.7').split(',').map(Number);
const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
// A ground point ahead: the camera's direction moved ~1 km along the view.
const c0 = norm(cam), fwd = norm(look.map((v, i) => v - cam[i]).map((v, i) => v - c0[i] * (look.map((w, j) => w - cam[j]).reduce((s, w, j) => s + w * c0[j], 0))));
const ahead = norm(c0.map((v, i) => v + fwd[i] * 1000 / R));
await gen.lakeTable.ensureArea(ahead, 30000);
const water = new WaterService({ device, terrainGenerator: gen, planetConfig: lab.planetConfig, useWorker: false });
await water.start();
const camPos = { x: ahead[0] * (R + 300), y: ahead[1] * (R + 300), z: ahead[2] * (R + 300) };
const L = water._lakeCells;
for (let k = 0; k < 3000 && (!water.lakes?.length || L.reading || L.planning || L.plannedKnown !== L.known.size); k++) { water.update(camPos); await new Promise(r => setTimeout(r, 100)); }
// The river point nearest the place ahead.
let best = null;
for (const rec of water.riverRecs.values()) {
    const P = rec.points, st = rec.stride;
    for (let k = 0; k < P.length / st; k++) {
        const d = 1 - (P[k * st] * ahead[0] + P[k * st + 1] * ahead[1] + P[k * st + 2] * ahead[2]);
        if (!best || d < best.d) best = { d, dir: [P[k * st], P[k * st + 1], P[k * st + 2]], rec };
    }
}
console.log(`nearest river ${(Math.acos(1 - best.d) * R).toFixed(0)} m from the place ahead, ${(best.rec.lengthM / 1000).toFixed(1)} km${best.rec.rapid ? ', with a rapid' : ''}`);
const gpu = new WaterGpuData(device, { gridN: water.config.gridN, planetRadius: R, carve: water.config.carve, maxLakes: 4096, maskLayerSize: 64, maskTilesPerAxis: 8, maxMaskLayers: 4096 });
const at = { x: best.dir[0] * (R + 300), y: best.dir[1] * (R + 300), z: best.dir[2] * (R + 300) };
gpu.update(water, at, 0);
const field = new RiverFieldService({ water: gpu, service: water, terrainGenerator: gen, config: water.config.riverField ?? {} });
for (let k = 0; k < 600 && !(field.stats && !field.busy); k++) { field.update(at); await new Promise(r => setTimeout(r, 50)); }
const W = 300, frame = { c: best.dir, ...tangentBasis(best.dir) };
const dirs = new Float32Array(W * W * 4);
for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) dirs.set([...planeToDir(i - W / 2, W / 2 - j, frame, R), 0], (j * W + i) * 4);
const nat = await water._sampler.sampleDirsNatural(dirs);
const h = nat.heights ?? nat;
const rgb = new Uint8Array(W * W * 3);
let wetEdgeSteps = 0;
for (let k = 0; k < W * W; k++) {
    const d = [dirs[k * 4], dirs[k * 4 + 1], dirs[k * 4 + 2]], f = sampleRiverField(field.pages, field.layout, d);
    const carved = h[k] + (f.found ? f.delta : 0);
    if (f.found && f.sdf > 0) { const depth = Math.min(1, Math.max(0, (f.W - carved) / 3)); rgb.set([20, 60 + 80 * (1 - depth), 140 + 100 * (1 - depth)], k * 3); }
    else { const cut = f.found ? Math.min(1, -f.delta / 10) : 0; const g = 150 - 80 * cut; rgb.set([g, g + 10, g - 20], k * 3); }
}
writePNG(out, W, W, rgb);
console.log(`map ${out}: ${W} m across at 1 m, centred on the river; field ${field.rivers.size} rivers baked`);
process.exit(0);
