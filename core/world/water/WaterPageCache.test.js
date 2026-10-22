import {describe,it,expect} from 'vitest';
import {WaterPageCache} from './WaterPageCache.js';
describe('local water page cache',()=>{
    it('coalesces requests and reuses a page independently of render LOD',async()=>{
        const c=new WaterPageCache({maxBytes:16});let calls=0;
        const load=async()=>{calls++;return new Uint8Array(8);};
        const [a,b]=await Promise.all([c.get('regional-shore/1','terrain-v1/water-v2',load),c.get('regional-shore/1','terrain-v1/water-v2',load)]);
        expect(a).toBe(b);expect(calls).toBe(1);
        expect(await c.get('regional-shore/1','terrain-v1/water-v2',load)).toBe(a);
        expect(await c.get('regional-shore/1','terrain-v1/water-v3',load)).not.toBe(a);
    });
    it('evicts least recently used entries to respect the byte budget',async()=>{
        const c=new WaterPageCache({maxBytes:16}),load=()=>new Uint8Array(8);
        await c.get('a',0,load);await c.get('b',0,load);await c.get('a',0,load);await c.get('c',0,load);
        expect([...c.entries.values()].map(e=>e.key)).toEqual(['a','c']);expect(c.bytes).toBe(16);
        c.evictWhere(key=>key==='a');expect(c.bytes).toBe(8);
    });
    it('does not publish an invalidated in-flight build',async()=>{
        const c=new WaterPageCache({maxBytes:16});let finish;
        const p=c.get('a',0,()=>new Promise(resolve=>{finish=resolve;}));await Promise.resolve();c.clear();
        finish(new Uint8Array(8));await expect(p).rejects.toThrow('invalidated');expect(c.bytes).toBe(0);
    });
    it('allows retries after a failed request and rejects oversized pages',async()=>{
        const c=new WaterPageCache({maxBytes:8});
        await expect(c.get('a',0,()=>{throw new Error('source unavailable');})).rejects.toThrow('unavailable');
        await expect(c.get('a',0,()=>new Uint8Array(16))).rejects.toThrow('budget');
        expect((await c.get('a',0,()=>new Uint8Array(8))).byteLength).toBe(8);
    });
});
