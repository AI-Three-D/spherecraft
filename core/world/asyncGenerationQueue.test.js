import { describe, expect, it, vi } from 'vitest';
import { AsyncGenerationQueue } from './asyncGenerationQueue.js';

describe('AsyncGenerationQueue admission', () => {
    it('admits a saturated burst without rescanning all candidates per request', () => {
        const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
        try {
            const dropCheck = vi.fn(() => false), replaceCheck = vi.fn(() => true);
            const q = new AsyncGenerationQueue({ maxQueueSize: 64, shouldDrop: dropCheck, canReplace: replaceCheck });
            for (let i = 0; i < 128; i++) {
                expect(q.request(String(i), i, () => true)).not.toBeNull();
            }
            expect(q.queue.length).toBe(64);
            expect(q.replacedCount).toBe(64);
            expect(dropCheck).toHaveBeenCalledTimes(64);
            expect(replaceCheck.mock.calls.length).toBeLessThan(256);
        } finally {
            clock.mockRestore();
        }
    });

    it('sorts a request batch on demand and promotes a gated request', async () => {
        const started = [];
        const q = new AsyncGenerationQueue({ maxPerFrame: 2 });
        const low = q.request('low', 1, () => started.push('low'));
        const gated = q.request('gated', 2, () => started.push('gated'), () => false);
        expect(q.request('gated', 10, () => {}, null)).toBe(gated);
        expect(q.peek().key).toBe('gated');
        expect(q.tick()).toBe(2);
        await Promise.all([low, gated]);
        expect(started).toEqual(['gated', 'low']);
    });

    it('reclaims stale requests at capacity without starting work', async () => {
        const dropped = [];
        const q = new AsyncGenerationQueue({ maxQueueSize: 1, maxPerFrame: 0,
            shouldDrop: e => e.key === 'old', onDrop: e => dropped.push(e.key) });
        const old = q.request('old', 100, () => { throw new Error('must not start'); });
        const current = q.request('current', 1, () => true);
        expect(current).not.toBeNull();
        expect(await old).toBe(false);
        expect(q.pending.has('old')).toBe(false);
        expect(dropped).toEqual(['old']);
        expect(q.consumeDroppedCount()).toBe(1);
        expect(q.active).toBe(0);
    });

    it('replaces the least urgent unprotected task and preserves active tasks', async () => {
        const q = new AsyncGenerationQueue({ maxQueueSize: 2, maxPerFrame: 1,
            canReplace: e => e.key !== 'protected' });
        let finish;
        const active = q.request('active', 10, () => new Promise(resolve => { finish = resolve; }));
        q.tick();
        await Promise.resolve();
        q.request('protected', 0, () => true);
        const far = q.request('far', 1, () => true);
        expect(q.request('near', 5, () => true)).not.toBeNull();
        expect(await far).toBe(false);
        expect(q.pending.has('active')).toBe(true);
        expect(q.pending.has('protected')).toBe(true);
        expect(q.request('less urgent', 2, () => true)).toBeNull();
        expect(q.consumeReplacedCount()).toBe(1);
        finish(true);
        await active;
    });

    it('demotes old priorities and retries deferred entries in priority order', async () => {
        const order = [];
        let ready = false;
        const q = new AsyncGenerationQueue({ maxPerFrame: 1 });
        const a = q.request('a', 100, () => order.push('a'), () => ready);
        const b = q.request('b', 50, () => order.push('b'));
        const c = q.request('c', 1, () => order.push('c'));
        q.reprioritize(e => e.key === 'c' ? 200 : e.priority);
        q.tick();
        await c;
        q.tick();
        await b;
        ready = true;
        q.tick();
        await a;
        expect(order).toEqual(['c', 'b', 'a']);
    });
});
