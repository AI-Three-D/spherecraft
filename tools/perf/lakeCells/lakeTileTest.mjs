// Real quadtree tiles with the 'lakeLand' base generator and its lake table,
// through the game's TileGenerator, in Node on the GPU (terrain-lab): GPU
// errors, table builds and tile times against earthLike.
//   node tools/perf/lakeCells/lakeTileTest.mjs          (from spherecraft/)
import { setupLab } from '../../../../terrain-lab/labsetup.mjs';

const mode = process.env.LAKE_BASE ?? 'lakeLand';
process.env.LAB_TERRAIN_JSON = JSON.stringify({ baseGenerator: mode, regionalTerrain: { enabled: false }, waterGraph: { enabled: false } });
const lab = await setupLab(process.cwd());
const { device, gen, imp } = lab;
const { TileGenerator } = await imp('core/world/quadtree/tileGenerator.js');
const { TileAddress } = await imp('core/world/quadtree/tileAddress.js');
const { dirToFaceUV } = await imp('core/world/hydrology/waterGraph.js');
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
const tileGen = new TileGenerator(gen, { textureSize: 128, requiredTypes: ['height', 'normal', 'tile'],
    textureFormats: { height: 'r32float', normal: 'rgba8unorm', tile: 'r8unorm' }, quadtreeMaxDepth: 14, maxGeomLOD: 6, enableSplat: false });
// Tiles around the spawn at several depths (a 3 x 3 block each).
const spawn = [-1, 0, 0], { face, u, v } = dirToFaceUV(spawn);
const rows = [];
for (const depth of [4, 7, 9, 11, 13]) {
    const g = 1 << depth, cx = Math.floor(u * g), cy = Math.floor(v * g);
    const times = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const addr = new TileAddress(face, depth, Math.max(0, Math.min(g - 1, cx + dx)), Math.max(0, Math.min(g - 1, cy + dy)));
        const t0 = performance.now();
        await tileGen.generateTile(addr);
        await device.queue.onSubmittedWorkDone();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    rows.push({ depth, medianMs: +times[4].toFixed(2), maxMs: +times[8].toFixed(2), table: gen.lakeTable ? { ...gen.lakeTable.stats } : null });
    console.log(`[tiles] ${mode} depth ${depth}: median ${times[4].toFixed(2)} ms, max ${times[8].toFixed(2)} ms${gen.lakeTable ? `, table ${gen.lakeTable.stats.records} records, last build ${gen.lakeTable.stats.lastNew} new in ${gen.lakeTable.stats.lastMs.toFixed(1)} ms` : ''}`);
}
// The water path: lake-cell water service, published into WaterGpuData.
if (gen.lakeTable) {
    const { WaterService } = await imp('core/world/hydrology/WaterService.js');
    const { WaterGpuData } = await imp('core/world/water/WaterGpuData.js');
    const water = new WaterService({ device, terrainGenerator: gen, planetConfig: lab.planetConfig, useWorker: false });
    await water.start();
    const R = lab.planetConfig.radius, spawnCam = { x: -R - 2000, y: 0, z: 0 };
    for (let k = 0; k < 50 && !water.lakes?.length; k++) { water.update(spawnCam); await new Promise(r => setTimeout(r, 50)); }
    // Rivers: wait for the planner to go through the published lakes.
    const L = water._lakeCells;
    const tr = performance.now();
    for (let k = 0; k < 3000 && L?.rivers && (L.reading || L.planning || L.plannedKnown !== L.known.size); k++) { water.update(spawnCam); await new Promise(r => setTimeout(r, 100)); }
    if (L?.rivers) {
        const st = L.rivers.stats, len = [...st.lengthsM].sort((a, b) => a - b), q = p => len.length ? len[Math.min(len.length - 1, Math.floor(p * len.length))] : 0;
        console.log(`[tiles] rivers: ${water.rivers.length} published of ${water.lakes.length} lakes; planned ${st.planned} ${JSON.stringify(st.byDest)}, ` +
            `none ${JSON.stringify(st.none)}, failed ${st.failed}${st.lastError ? ` (last: ${st.lastError})` : ''}`);
        console.log(`[tiles] river lengths m: median ${q(0.5)}, p90 ${q(0.9)}, max ${q(1)}; planning ${(st.ms / 1000).toFixed(1)} s busy ` +
            `(${((performance.now() - tr) / 1000).toFixed(1)} s wall), longest slice ${st.longestSliceMs.toFixed(1)} ms, ` +
            `flood cells ${st.floodCells}, grid samples ${L.rivers.grid.samples}, tiles ${L.rivers.grid.tiles.size}`);
        console.log(`[tiles] lake table after rivers: ${JSON.stringify(gen.lakeTable.stats)}`);
        console.log(`[tiles] river sync chunks ms: corridor ${(st.longestCorridorMs ?? 0).toFixed(1)}, course ${st.longestCourseMs.toFixed(1)}, index ${st.longestIndexMs.toFixed(1)}; flood cells by outcome ${JSON.stringify(st.floodCellsByOutcome)}`);
    }
    const gpu = new WaterGpuData(device, { gridN: water.config.gridN, planetRadius: lab.planetConfig.radius, carve: water.config.carve, maxLakes: 4096, maskLayerSize: 64, maskTilesPerAxis: 8, maxMaskLayers: 4096 });
    // Where the water data's main-thread time goes (LAKE_GPU_PROFILE=1).
    const prof = {};
    if (process.env.LAKE_GPU_PROFILE) for (const m of ['_buildInitialIndex', '_unapply', '_setSlot', '_allocLayer', '_uploadMask', '_rebuildRivers', '_flushRows', '_writeTable']) {
        const f = gpu[m].bind(gpu);
        gpu[m] = (...a) => { const t = performance.now(); try { return f(...a); } finally { const e = (prof[m] ??= { n: 0, ms: 0 }); e.n++; e.ms += performance.now() - t; } };
    }
    let tu = performance.now();
    gpu.update(water, { x: -R - 2000, y: 0, z: 0 }, 0);
    const firstMs = performance.now() - tu;
    if (process.env.LAKE_GPU_PROFILE) {
        let listings = 0, segs = 0;
        for (const r of water.riverRecs.values()) { listings += r.segCells.length; segs += r.points.length / r.stride - 1; }
        console.log(`[tiles] river segments ${segs}, sub-cell listings ${listings}, rows written ${gpu.riverSegCount}`);
    }
    if (process.env.LAKE_GPU_PROFILE) console.log(`[tiles] water data first update by step ${JSON.stringify(Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, { n: v.n, ms: +v.ms.toFixed(1) }])))}`);
    await device.queue.onSubmittedWorkDone();
    // A republication (as after each table build or river batch): main-thread cost of applying it.
    // New lakes from the table (river planning sampled a wide area), then
    // a republication with nothing new.
    for (const l of (await gen.lakeTable.readLakes()).sort((a, b) => (a.key < b.key ? -1 : 1))) if (!L.known.has(l.key)) L.known.set(l.key, l);
    water._publishLakeCells();
    tu = performance.now();
    gpu.update(water, { x: -R - 2000, y: 0, z: 0 }, 0);
    const moreMs = performance.now() - tu, more = water.lakes.length;
    water._publishLakeCells();
    tu = performance.now();
    gpu.update(water, { x: -R - 2000, y: 0, z: 0 }, 0);
    console.log(`[tiles] water data update: first ${firstMs.toFixed(1)} ms, with ${more} lakes ${moreMs.toFixed(1)} ms, republication unchanged ${(performance.now() - tu).toFixed(1)} ms (${water.rivers.length} rivers)`);
    await device.queue.onSubmittedWorkDone();
    console.log(`[tiles] water: state ${water.state}, ${water.lakes.length} lakes published, gpu ready ${gpu._ready}, levels ${water.lakes.slice(0, 3).map(l => l.level.toFixed(1)).join(', ')}`);
    // The river field (what the terrain carves and the near water draws):
    // baked for the rivers around the spawn, as the game's frame loop does.
    {
        const { RiverFieldService } = await imp('core/world/water/RiverFieldService.js');
        const field = new RiverFieldService({ water: gpu, service: water, terrainGenerator: gen, config: water.config.riverField ?? {} });
        // Over the middle of the first river (the field bakes within its radius of the camera).
        const r0 = [...water.riverRecs.values()][0], m = Math.floor(r0.points.length / r0.stride / 2) * r0.stride;
        const cam = { x: r0.points[m] * (R + 500), y: r0.points[m + 1] * (R + 500), z: r0.points[m + 2] * (R + 500) }, t0 = performance.now();
        for (let k = 0; k < 600 && !(field.stats && !field.busy); k++) { field.update(cam); await new Promise(r => setTimeout(r, 50)); }
        if (process.env.LAKE_FIELD_DEBUG) console.log('[tiles] field debug', JSON.stringify({ applied: gpu._appliedRivers.size, recs: water.riverRecs?.size, sampler: !!water._sampler,
            ready: gpu._ready, near: field._nearRivers([cam.x, cam.y, cam.z].map(v => v / Math.hypot(cam.x, cam.y, cam.z))).length, radiusM: field.config.radiusM, busy: field.busy, idle: field.isIdle, pending: field._pending,
            appliedVersion: gpu._appliedVersion, version: water.version, first: [...(water.riverRecs?.values() ?? [])][0] && Object.keys([...water.riverRecs.values()][0]) }));
        console.log(`[tiles] river field: ${field.rivers.size} rivers baked, ${field.wetPages?.length ?? 0} wet pages, ${field.stats?.pages ?? 0} pages, ` +
            `${((performance.now() - t0) / 1000).toFixed(1)} s${field.lastError ? `, error ${field.lastError}` : ''}`);
        field.dispose?.();
    }
}
console.log(`[tiles] GPU errors: ${errors.length}${errors.length ? ' ' + errors.slice(0, 3).join(' | ') : ''}`);
process.exit(0);
