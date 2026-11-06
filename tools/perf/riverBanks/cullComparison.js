// Compare the current published field against the uncullled bake at the same pose.
import { riverFieldLakeCandidates } from '../../../core/world/water/riverField.js';
import { sampleNaturalFieldPages } from '../../../core/world/water/NaturalTerrainPageCache.js';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export async function comparePageCull() {
    const g = window.gameEngine, f = g.riverFieldService, water = f.water;
    const deadline = performance.now() + 120000;
    while ((f.busy || !f.isIdle || water._appliedVersion !== f.revision) && performance.now() < deadline) await new Promise(r => setTimeout(r, 200));
    if (f.busy || !f.isIdle || water._appliedVersion !== f.revision) throw new Error('Field did not settle');
    const revision = water._appliedVersion, previousBusy = f.busy, currentStats = f.stats;
    f.busy = true;
    try {
        const rivers = f._riverInputs([...f.rivers]);
        const plain = rivers.map(r => ({ rec: { points: r.rec.points, stride: r.rec.stride, mouths: r.rec.mouths ?? [] },
            arc: r.arc, rid: r.rid, levels: r.levels, srcLevel: r.srcLevel, destLevel: r.destLevel }));
        const L = f.layout, prep = await f._prepare(plain);
        f.naturalCache.setSource(f.service._sampler, f.generator._regionalTerrainInputRevision ?? 0);
        const { nat } = await sampleNaturalFieldPages({ keys: prep.keys, dirs4: prep.dirs4, pageSamples: L.P * L.P,
            sampler: f.service._sampler, cache: f.naturalCache });
        let slice = performance.now();
        const pause = async () => { if (performance.now() - slice >= 3) { await new Promise(r => setTimeout(r, 0)); slice = performance.now(); } };
        const lakeCand = await riverFieldLakeCandidates({ rivers, dirs4: prep.dirs4, nat, lakeAt: d => water.lakeEdgeAt(d), pause });
        const result = await f._finish({ rivers: plain, L, keys: prep.keys, pageRivers: prep.pageRivers, dirs4: prep.dirs4, nat, lakeCand, cullPages: false });
        let pagesDifferent = 0, flowDifferent = 0, missingPages = 0;
        prep.keys.forEach((key, i) => {
            const old = f.pages.get(key), slot = f.slots.get(key);
            if (!old || slot === undefined) { missingPages++; return; }
            if (!same(old, result.pages.get(key))) pagesDifferent++;
            if (!same(f.flow.subarray(slot * L.TEX, (slot + 1) * L.TEX), result.flow.subarray(i * L.TEX, (i + 1) * L.TEX))) flowDifferent++;
        });
        return { pages: prep.keys.length, publishedPages: f.pages.size, stableRevision: revision === water._appliedVersion && revision === f.revision,
            missingPages, pagesDifferent, flowDifferent, rocksIdentical: same(f.rocks, result.rocks),
            withCull: { texelsMs: currentStats.ms.texels, finishMs: currentStats.ms.finish,
                emptyTexelPages: currentStats.emptyTexelPages, culledPageRivers: currentStats.culledPageRivers },
            withoutCull: { texelsMs: result.stats.ms.texels, finishMs: result.stats.ms.finish } };
    } finally { f.busy = previousBusy; }
}
