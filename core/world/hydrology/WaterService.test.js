import {describe,it,expect,vi} from 'vitest';
import {WaterService} from './WaterService.js';

function service() {
    const s=Object.create(WaterService.prototype);
    Object.assign(s,{refined:new Map(),mergedInto:new Map(),riverRecs:new Map(),rivers:[],lakes:[],
        _failedRivers:new Set(),version:0,valleyUpdates:[],config:{valley:{enabled:true}},terrainGenerator:{riverValley:true},
        _client:{call:vi.fn(async()=>({pageIds:new Int32Array([7]),texels:new Uint32Array(4)}))}});
    return s;
}

describe('lake changes invalidate dependent rivers',()=>{
    it('invalidates a reach when a newly refined intermediate lake enters its solve patch',async()=>{
        const s=service();s.radius=131072;
        const frame={c:[0,0,1],nx:100,ny:40,spacing:16};
        const distant={...frame,c:[1,0,0]};
        s.refined.set(0,{level:50,frame});
        const identity=s._riverLakeIdentity(frame);
        s.riverRecs=new Map([[10,{src:0,dest:{type:'lake',id:3},dependencyFrame:frame}],
            [11,{src:8,dest:{type:'lake',id:9},dependencyFrame:distant}]]);
        await s._apply(5,{level:40,frame,mask:new Uint8Array([2])});
        expect([...s.riverRecs.keys()]).toEqual([11]);
        expect(s._riverLakeIdentity(frame)).not.toBe(identity);
        const current=s._riverLakeIdentity(frame);
        await s._apply(7,{level:20,frame:distant});
        expect(s._riverLakeIdentity(frame)).toBe(current);
    });
    it('removes incoming, absorbed-source and dependent tributary traces, preserving unrelated rivers',async()=>{
        const s=service();
        s.refined.set(3,{level:551});s.refined.set(6,{level:538});
        s.riverRecs=new Map([[10,{src:0,dest:{type:'lake',id:3}}],[11,{src:3,dest:{type:'lake',id:6}}],
            [12,{src:2,dest:{type:'river',id:10}}],[13,{src:8,dest:{type:'lake',id:9}}]]);
        s.rivers=[{id:10,fromLake:0,to:{type:'lake',id:3}},{id:11,fromLake:3},{id:14,fromLake:6}];
        s._failedRivers=new Set([10,11,14,99]);
        await s._apply(6,{level:548,merged:[3]});
        expect([...s.riverRecs.keys()]).toEqual([13]);
        expect(s.rep(3)).toBe(6);expect(s.refined.has(3)).toBe(false);
        expect([...s._failedRivers]).toEqual([99]);
        expect(s._client.call).toHaveBeenCalledWith({type:'removeRivers',riverIds:[10,11,12],opts:{enabled:true}});
        expect(s.valleyUpdates[0].pageIds[0]).toBe(7);
    });
    it('changes cache identity when level, shoreline or representative changes, including after restart',async()=>{
        const s=service(),rec={level:10,frame:{nx:2,ny:2},mask:new Uint8Array([2,0,0,0]),exitDir:[0,0,1]};
        s.refined.set(1,rec);const a=s._lakeIdentity(1);
        const restarted=service();restarted.refined.set(1,structuredClone(rec));
        expect(restarted._lakeIdentity(1)).toBe(a);
        s.refined.set(1,{...rec,level:11});expect(s._lakeIdentity(1)).not.toBe(a);
        s.refined.set(1,{...rec,mask:new Uint8Array([2,2,0,0])});expect(s._lakeIdentity(1)).not.toBe(a);
        s.refined.set(2,rec);s.mergedInto.set(1,2);expect(s._lakeIdentity(1)).not.toBe(a);
    });
});
