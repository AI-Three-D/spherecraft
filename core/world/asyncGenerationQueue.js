export class AsyncGenerationQueue {
    constructor({
        maxInFlight = 20,
        maxPerFrame = 10,
        timeBudgetMs = 20,
        maxQueueSize = 4096,
        minStartIntervalMs = 0,
        shouldDrop = null
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
        this._shouldDrop = shouldDrop;
        this.droppedCount = 0;
    }

    request(key, priority, task, canStart = null) {
        const existing = this.pending.get(key);
        if (existing) {
            // A tile can be re-requested with a different (higher) priority
            // or a looser admission gate before it starts — e.g. a
            // PREDICTIVE request for a tile that becomes genuinely VISIBLE
            // before generation begins. Promote in place rather than
            // leaving it stuck with its original, more conservative
            // priority/gate (never demote — the first caller's urgency
            // still applies once granted).
            if (!existing.started) {
                const p = Number.isFinite(priority) ? priority : 0;
                if (p > existing.priority) {
                    existing.priority = p;
                    this.queue.sort((a, b) => b.priority - a.priority);
                }
                if (existing.canStart && canStart === null) {
                    existing.canStart = null;
                }
            }
            return existing.promise;
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

    /** Reset the diagnostic drop counter and return its previous value. */
    consumeDroppedCount() {                // NEW
        const count = this.droppedCount;
        this.droppedCount = 0;
        return count;
    }

    tick() {
        // ── Phase 1: bulk prune stale entries ──────────────────────────
        // This runs BEFORE the start loop so dropped entries never consume
        // a start slot or time budget.
        if (this._shouldDrop && this.queue.length > 0) {
            let writeIdx = 0;
            for (let readIdx = 0; readIdx < this.queue.length; readIdx++) {
                const entry = this.queue[readIdx];
                if (!entry.started && this._shouldDrop(entry)) {
                    this.pending.delete(entry.key);
                    entry.resolve(false);
                    this.droppedCount++;
                    continue;
                }
                this.queue[writeIdx++] = entry;
            }
            this.queue.length = writeIdx;
        }

        // ── Phase 2: start tasks (unchanged logic) ────────────────────
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
        // Tasks started this tick. They only run once the caller's
        // synchronous frame code returns (microtasks), so callers that budget
        // GPU work must count them by hand.
        return spawned;
    }
}
