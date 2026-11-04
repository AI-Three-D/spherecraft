// core/world/water/riverFieldWorker.js
//
// Module worker for the river field bake's CPU parts (riverField.js): the
// pages and their directions (prepare), then stations, texels, blur, connected
// water, signed distances and the GPU pages. The main thread samples the
// natural ground and the lake masks (RiverFieldService.js).

import { finishRiverFieldBake, prepareRiverFieldBake, riverFieldPageFacts } from './riverField.js';

self.onmessage = (e) => {
    const { id, msg } = e.data;
    try {
        if (msg.prepare) {
            const prep = prepareRiverFieldBake(msg);
            self.postMessage({ id, reply: prep }, [prep.dirs4.buffer]);
            return;
        }
        const { pages, stats } = finishRiverFieldBake({ ...msg, onProgress: (stage, info) => self.postMessage({ id, progress: { stage, info } }) });
        const keys = [...pages.keys()], size = keys.length ? pages.get(keys[0]).length : 0;
        const data = new Uint32Array(keys.length * size);
        keys.forEach((k, i) => data.set(pages.get(k), i * size));
        const { hash, wet } = riverFieldPageFacts(keys, pages, msg.L);
        self.postMessage({ id, reply: { keys, size, data, stats, hash, wet } }, [data.buffer, hash.buffer, wet.buffer]);
    } catch (error) {
        self.postMessage({ id, error: String(error?.stack || error) });
    }
};
