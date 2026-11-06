import { describe, expect, it } from 'vitest';
import { NaturalTerrainPageCache, sampleNaturalFieldPages } from './NaturalTerrainPageCache.js';

const pageSamples = 4;
const directions = keys => Float32Array.from(keys.flatMap(key => Array.from({ length: pageSamples }, (_, i) => [key, i, key + i, 0]).flat()));
const makeSampler = () => ({ calls: [], async sampleDirsNatural(dirs) {
    this.calls.push(dirs.length / 4);
    return Float32Array.from({ length: dirs.length / 4 }, (_, i) => dirs[i * 4] * 10 + dirs[i * 4 + 1]);
} });
const sample = (keys, sampler, cache) => sampleNaturalFieldPages({ keys, dirs4: directions(keys), pageSamples, sampler, cache, maxChunkSamples: 8 });

describe('natural terrain page cache', () => {
    it('reuses overlapping pages while retaining the original order and values', async () => {
        const sampler = makeSampler(), cache = new NaturalTerrainPageCache(4 * pageSamples * 4);
        cache.setSource(sampler, 0);
        const first = await sample([1, 2, 3], sampler, cache);
        expect(first.sampledPages).toBe(3);
        expect(sampler.calls).toEqual([8, 4]);
        sampler.calls.length = 0;
        const next = await sample([3, 4, 1], sampler, cache);
        expect(next.reusedPages).toBe(2);
        expect(next.sampledPages).toBe(1);
        expect(sampler.calls).toEqual([4]);
        const reference = await sample([3, 4, 1], makeSampler(), new NaturalTerrainPageCache(0));
        expect(next.nat).toEqual(reference.nat);
        // Cache entries must survive transfer of the returned bake buffer.
        structuredClone(next.nat, { transfer: [next.nat.buffer] });
        expect((await sample([3, 1], sampler, cache)).reusedPages).toBe(2);
    });

    it('collects all hits before inserting misses and respects the memory limit', async () => {
        const sampler = makeSampler(), cache = new NaturalTerrainPageCache(2 * pageSamples * 4);
        cache.setSource(sampler, 0);
        await sample([1, 2], sampler, cache);
        const result = await sample([3, 1, 2], sampler, cache);
        expect(result.reusedPages).toBe(2);
        expect(cache.bytes).toBe(2 * pageSamples * 4);
        expect(cache.pages.size).toBe(2);
    });

    it('invalidates on a new sampler or terrain revision and can be disabled', async () => {
        const sampler = makeSampler(), cache = new NaturalTerrainPageCache(pageSamples * 4);
        cache.setSource(sampler, 1);
        await sample([1], sampler, cache);
        cache.setSource(sampler, 2);
        expect((await sample([1], sampler, cache)).reusedPages).toBe(0);
        cache.setSource(makeSampler(), 2);
        expect(cache.bytes).toBe(0);
        const disabled = new NaturalTerrainPageCache(0);
        await sample([1], sampler, disabled);
        expect((await sample([1], sampler, disabled)).reusedPages).toBe(0);
    });

    it('does not cache partial results if a sampling dispatch fails', async () => {
        const cache = new NaturalTerrainPageCache(10 * pageSamples * 4);
        const sampler = makeSampler();
        sampler.sampleDirsNatural = async dirs => {
            if (sampler.calls.length) throw new Error('GPU unavailable');
            sampler.calls.push(dirs.length);
            return new Float32Array(dirs.length / 4);
        };
        await expect(sample([1, 2, 3], sampler, cache)).rejects.toThrow('GPU unavailable');
        expect(cache.bytes).toBe(0);
    });
});
