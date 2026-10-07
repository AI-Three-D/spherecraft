export class AsyncGenerationQueue {
    constructor({
        maxInFlight = 20,
        maxPerFrame = 10,
        timeBudgetMs = 20,
        maxQueueSize = 4096,
        minStartIntervalMs = 0,
        shouldDrop = null,
        onDrop = null,
        canReplace = null,
        requestPruneIntervalMs = 16
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
        this._onDrop = onDrop;
        this._canReplace = canReplace;
        this._replacementCandidates = null;
        this._lastPruneTime = -Infinity;
        this.requestPruneIntervalMs = requestPruneIntervalMs;
        this._sortDirty = false;
        this.droppedCount = 0;
        this.replacedCount = 0;
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
                    this._sortDirty = true;
                    this.invalidateReplacementCandidates();
                }
                if (existing.canStart && canStart === null) {
                    existing.canStart = null;
                }
            }
            return existing.promise;
        }

        if (this.queue.length >= this.maxQueueSize) {
            // Admission can happen while GPU backpressure prevents starts.
            // Reclaim obsolete requests before rejecting current demand.
            // A feedback burst can offer hundreds of new tiles at once.
            // Don't rescan the same full backlog for every one of them.
            if (performance.now() - this._lastPruneTime >= this.requestPruneIntervalMs) {
                this.prunePending();
            }
            if (this.queue.length >= this.maxQueueSize) {
                const incomingPriority = Number.isFinite(priority) ? priority : 0;
                const entry = this._takeReplacementCandidate(incomingPriority);
                if (!entry) return null;
                this.queue.splice(this.queue.indexOf(entry), 1);
                this._drop(entry);
                this.replacedCount++;
            }
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
        this._sortDirty = true;
        if (this._replacementCandidates && this._canReplace(entry)) {
            // Keep the candidate list descending so its cheapest entry is
            // popped in O(1). Binary insertion avoids full sorting per offer.
            let lo = 0, hi = this._replacementCandidates.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (this._replacementCandidates[mid].priority > entry.priority) lo = mid + 1;
                else hi = mid;
            }
            this._replacementCandidates.splice(lo, 0, entry);
        }

        return promise;
    }

    cancel(key) {
        const entry = this.pending.get(key);
        if (!entry) return false;
        if (entry.started) return false;
        this.pending.delete(key);
        this.queue = this.queue.filter(item => item.key !== key);
        this.invalidateReplacementCandidates();
        entry.resolve(null);
        return true;
    }

    clearPending(resolutionValue = null) {
        const queued = this.queue;
        this.queue = [];
        this._sortDirty = false;
        this.invalidateReplacementCandidates();

        for (const entry of queued) {
            if (entry?.started) continue;
            this.pending.delete(entry.key);
            entry.resolve(resolutionValue);
        }

        return queued.length;
    }

    /** Reset the diagnostic drop counter and return its previous value. */
    consumeDroppedCount() {
        const count = this.droppedCount;
        this.droppedCount = 0;
        return count;
    }

    consumeReplacedCount() {
        const count = this.replacedCount;
        this.replacedCount = 0;
        return count;
    }

    _drop(entry) {
        this.pending.delete(entry.key);
        entry.resolve(false);
        this.droppedCount++;
        this._onDrop?.(entry);
    }

    invalidateReplacementCandidates() {
        this._replacementCandidates = null;
    }

    _takeReplacementCandidate(priority) {
        if (!this._canReplace) return null;
        if (!this._replacementCandidates) {
            this._replacementCandidates = this.queue.filter(entry => this._canReplace(entry));
            this._replacementCandidates.sort((a, b) => b.priority - a.priority);
        }
        while (this._replacementCandidates.length > 0) {
            const entry = this._replacementCandidates.pop();
            // Started/cancelled entries can outlive their candidate reference;
            // protection can also change after the list was built.
            if (entry.started || this.pending.get(entry.key) !== entry || !this._canReplace(entry)) continue;
            if (entry.priority >= priority) {
                this._replacementCandidates.push(entry);
                return null;
            }
            return entry;
        }
        return null;
    }

    // Sorting once per admission batch avoids sorting the entire backlog on
    // every request. Consumers needing the most urgent entry use peek().
    peek() {
        if (this._sortDirty) {
            this.queue.sort((a, b) => b.priority - a.priority);
            this._sortDirty = false;
        }
        return this.queue[0];
    }

    reprioritize(getPriority) {
        for (const entry of this.queue) {
            const priority = getPriority(entry);
            if (Number.isFinite(priority) && priority !== entry.priority) {
                entry.priority = priority;
                this._sortDirty = true;
                this.invalidateReplacementCandidates();
            }
        }
    }

    prunePending() {
        const now = performance.now();
        this._lastPruneTime = now;
        if (!this._shouldDrop || this.queue.length === 0) return 0;
        const before = this.queue.length;
        let writeIdx = 0;
        for (let readIdx = 0; readIdx < before; readIdx++) {
            const entry = this.queue[readIdx];
            if (this._shouldDrop(entry, now)) {
                this._drop(entry);
            } else {
                this.queue[writeIdx++] = entry;
            }
        }
        this.queue.length = writeIdx;
        if (writeIdx !== before) this.invalidateReplacementCandidates();
        return before - writeIdx;
    }

    tick() {
        // ── Phase 1: bulk prune stale entries ──────────────────────────
        // This runs BEFORE the start loop so dropped entries never consume
        // a start slot or time budget.
        this.prunePending();
        this.peek();

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
                this._sortDirty = true;
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
        if (spawned > 0) this.invalidateReplacementCandidates();
        return spawned;
    }
}
