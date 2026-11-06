// Bounded CPU cache of the natural heights sampled for river-field pages.
// It is scoped to a sampler and terrain-input revision, never to water state.
export class NaturalTerrainPageCache {
    constructor(maxBytes) {
        this.maxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
        this.pages = new Map();
        this.bytes = 0;
        this.source = null;
        this.revision = null;
    }

    setSource(source, revision) {
        if (this.source === source && this.revision === revision) return;
        this.clear();
        this.source = source;
        this.revision = revision;
    }

    get(key) {
        const page = this.pages.get(key);
        if (!page) return null;
        this.pages.delete(key);
        this.pages.set(key, page);
        return page;
    }

    set(key, values) {
        if (values.byteLength > this.maxBytes) return;
        const old = this.pages.get(key);
        if (old) { this.bytes -= old.byteLength; this.pages.delete(key); }
        // The input is later transferred to the field worker and detached.
        const page = values.slice();
        while (this.bytes + page.byteLength > this.maxBytes) {
            const oldest = this.pages.keys().next().value;
            this.bytes -= this.pages.get(oldest).byteLength;
            this.pages.delete(oldest);
        }
        this.pages.set(key, page);
        this.bytes += page.byteLength;
    }

    clear() { this.pages.clear(); this.bytes = 0; }
}

// Sample only missing pages. All hits are collected before inserting misses,
// so an over-capacity bake does not evict hits before it can reuse them.
export async function sampleNaturalFieldPages({ keys, dirs4, pageSamples, sampler, cache, maxChunkSamples = 1 << 21 }) {
    const nat = new Float32Array(keys.length * pageSamples), missing = [];
    for (let p = 0; p < keys.length; p++) {
        const cached = cache.get(keys[p]);
        if (cached && cached.length === pageSamples) nat.set(cached, p * pageSamples);
        else missing.push(p);
    }
    const pagesPerChunk = Math.max(1, Math.floor(maxChunkSamples / pageSamples));
    for (let i = 0; i < missing.length; i += pagesPerChunk) {
        const group = missing.slice(i, i + pagesPerChunk);
        let directions;
        if (missing.length === keys.length) {
            // The cold case is already contiguous: no second directions copy.
            const from = group[0] * pageSamples * 4;
            directions = dirs4.subarray(from, from + group.length * pageSamples * 4);
        } else {
            directions = new Float32Array(group.length * pageSamples * 4);
            for (let k = 0; k < group.length; k++) {
                const from = group[k] * pageSamples * 4;
                directions.set(dirs4.subarray(from, from + pageSamples * 4), k * pageSamples * 4);
            }
        }
        const sampled = await sampler.sampleDirsNatural(directions);
        if (!sampled || sampled.length !== group.length * pageSamples) throw new Error('natural ground unavailable');
        for (let k = 0; k < group.length; k++) {
            nat.set(sampled.subarray(k * pageSamples, (k + 1) * pageSamples), group[k] * pageSamples);
        }
    }
    // Publish only after every sampling dispatch succeeds.
    for (const p of missing) cache.set(keys[p], nat.subarray(p * pageSamples, (p + 1) * pageSamples));
    return { nat, sampledPages: missing.length, reusedPages: keys.length - missing.length };
}
