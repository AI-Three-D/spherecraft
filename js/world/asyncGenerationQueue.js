export class AsyncGenerationQueue {
    constructor({
        maxInFlight = 20,
        maxPerFrame = 10,
        timeBudgetMs = 20,
        maxQueueSize = 4096,
        minStartIntervalMs = 0
    } = {}) {
        this.pending = new Map();
        this.queue = [];
        this.active = 0;
        this.maxInFlight = maxInFlight;
        this.maxPerFrame = maxPerFrame;
        this.timeBudgetMs = timeBudgetMs;
        this.maxQueueSize = maxQueueSize;
        this.minStartIntervalMs = minStartIntervalMs;
        this._lastStartTime = -Infinity;
    }

    request(key, priority, task, canStart = null) {
        if (this.pending.has(key)) {
            return this.pending.get(key).promise;
        }

        if (this.queue.length >= this.maxQueueSize) {
            return null;
        }

        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });

        const entry = {
            key,
            priority: Number.isFinite(priority) ? priority : 0,
            task,
            canStart,
            resolve,
            reject,
            promise,
            enqueuedAt: performance.now()
        };

        this.pending.set(key, entry);
        this.queue.push(entry);
        this.queue.sort((a, b) => b.priority - a.priority);

        return promise;
    }

    cancel(key) {
        const entry = this.pending.get(key);
        if (!entry) return false;
        if (entry.started) return false;
        this.pending.delete(key);
        this.queue = this.queue.filter(item => item.key !== key);
        entry.resolve(null);
        return true;
    }

    clearPending(resolutionValue = null) {
        const queued = this.queue;
        this.queue = [];

        for (const entry of queued) {
            if (entry?.started) continue;
            this.pending.delete(entry.key);
            entry.resolve(resolutionValue);
        }

        return queued.length;
    }

    tick() {
        const start = performance.now();
        let spawned = 0;
        let deferrals = 0;

        while (this.active < this.maxInFlight &&
               spawned < this.maxPerFrame &&
               this.queue.length > 0) {
            if (performance.now() - start > this.timeBudgetMs) break;

            const entry = this.queue.shift();
            if (!entry) break;

            if (entry.canStart && !entry.canStart()) {
                this.queue.push(entry);
                deferrals++;
                if (deferrals >= this.queue.length) break;
                continue;
            }
            if (this.minStartIntervalMs > 0 && (performance.now() - this._lastStartTime) < this.minStartIntervalMs) {
                this.queue.unshift(entry);
                break;
            }

            entry.started = true;
            this.active++;
            spawned++;
            this._lastStartTime = performance.now();

            Promise.resolve()
                .then(entry.task)
                .then(result => entry.resolve(result))
                .catch(err => entry.reject(err))
                .finally(() => {
                    this.active = Math.max(0, this.active - 1);
                    this.pending.delete(entry.key);
                });
        }
    }
}
