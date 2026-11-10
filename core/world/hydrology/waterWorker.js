// core/world/hydrology/waterWorker.js
//
// Module worker around waterWorkerCore.js (graph build, fine lake solves).
// Replies carry the request id; errors come back as { id, error }.

import { createWaterWorkerCore } from './waterWorkerCore.js';

const core = createWaterWorkerCore();

self.onmessage = (e) => {
    const { id, msg } = e.data;
    try {
        const { reply, transfer = [] } = core.handle(msg);
        self.postMessage({ id, reply }, transfer);
    } catch (err) {
        self.postMessage({ id, error: String(err?.stack || err) });
    }
};
