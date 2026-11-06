// Diagnostic experiment: compare full published pages with isolated group bakes.
// The production path is unchanged. Run only after the water field is settled.
import { fieldPageGroups } from './fieldGroups.js';
import { riverFieldLakeCandidates } from '../../../core/world/water/riverField.js';
import { sampleNaturalFieldPages } from '../../../core/world/water/NaturalTerrainPageCache.js';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const recordCounts = (data, counts, sign) => {
    const words = new Uint32Array(data.buffer, data.byteOffset, data.length);
    for (let i = 0; i < words.length; i += 9) {
        const key = [...words.subarray(i, i + 9)].join(',');
        counts.set(key, (counts.get(key) ?? 0) + sign);
    }
};

export async function compareFieldGroups() {
    const g = window.gameEngine, f = g.riverFieldService, water = f.water;
    const deadline = performance.now() + 120000;
    while ((f.busy || !f.isIdle || water._appliedVersion !== f.revision) && performance.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
    }
    if (f.busy || !f.isIdle || water._appliedVersion !== f.revision) throw new Error('Field did not settle');
    const revision = water._appliedVersion, previousBusy = f.busy;
    f.busy = true;
    try {
        const rivers = f._riverInputs([...f.rivers]);
        const plain = rivers.map(r => ({ rec: { points: r.rec.points, stride: r.rec.stride, mouths: r.rec.mouths ?? [] },
            arc: r.arc, rid: r.rid, levels: r.levels, srcLevel: r.srcLevel, destLevel: r.destLevel }));
        const L = f.layout, PP = L.P * L.P, prep = await f._prepare(plain);
        const groups = fieldPageGroups(prep.keys, prep.pageRivers, L, { includeMembers: true });
        f.naturalCache.setSource(f.service._sampler, f.generator._regionalTerrainInputRevision ?? 0);
        const { nat } = await sampleNaturalFieldPages({ keys: prep.keys, dirs4: prep.dirs4, pageSamples: PP,
            sampler: f.service._sampler, cache: f.naturalCache });
        let slice = performance.now();
        const pause = async () => { if (performance.now() - slice >= 3) { await new Promise(r => setTimeout(r, 0)); slice = performance.now(); } };
        const lakeCand = await riverFieldLakeCandidates({ rivers, dirs4: prep.dirs4, nat, lakeAt: d => water.lakeEdgeAt(d), pause });
        const mismatchedPages = [], mismatchedFlowPages = [], missingPages = [], counts = new Map();
        recordCounts(f.rocks, counts, 1);
        let totalMs = 0;
        for (const group of groups) {
            const indices = new Map(group.riverIndices.map((v, i) => [v, i]));
            const dirs4 = new Float32Array(group.pages * PP * 4), heights = new Float32Array(group.pages * PP), lakes = new Float32Array(group.pages * PP);
            group.slots.forEach((slot, i) => {
                dirs4.set(prep.dirs4.subarray(slot * PP * 4, (slot + 1) * PP * 4), i * PP * 4);
                heights.set(nat.subarray(slot * PP, (slot + 1) * PP), i * PP);
                lakes.set(lakeCand.subarray(slot * PP, (slot + 1) * PP), i * PP);
            });
            const keys = group.slots.map(i => prep.keys[i]), pageRivers = group.slots.map(i => prep.pageRivers[i].map(r => indices.get(r)));
            const result = await f._finish({ rivers: group.riverIndices.map(i => plain[i]), L, keys, pageRivers, dirs4, nat: heights, lakeCand: lakes });
            totalMs += result.stats.ms.finish;
            recordCounts(result.rocks, counts, -1);
            keys.forEach((key, i) => {
                const old = f.pages.get(key), oldSlot = f.slots.get(key);
                if (!old || oldSlot === undefined) { missingPages.push(key); return; }
                if (!same(old, result.pages.get(key))) mismatchedPages.push(key);
                if (!same(f.flow.subarray(oldSlot * L.TEX, (oldSlot + 1) * L.TEX), result.flow.subarray(i * L.TEX, (i + 1) * L.TEX))) mismatchedFlowPages.push(key);
            });
        }
        return { pages: prep.keys.length, publishedPages: f.pages.size, groups: groups.length, riverCount: rivers.length,
            largest: groups[0] && { pages: groups[0].pages, rivers: groups[0].rivers }, totalWorkerMs: totalMs,
            stableRevision: revision === water._appliedVersion && revision === f.revision,
            missingPages: missingPages.length, mismatchedPages: mismatchedPages.length, mismatchedFlowPages: mismatchedFlowPages.length,
            mismatchedRockRecords: [...counts.values()].reduce((n, v) => n + Math.abs(v), 0),
            examples: { missingPages: missingPages.slice(0, 8), mismatchedPages: mismatchedPages.slice(0, 8), mismatchedFlowPages: mismatchedFlowPages.slice(0, 8) } };
    } finally { f.busy = previousBusy; }
}
