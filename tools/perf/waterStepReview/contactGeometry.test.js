import { describe, expect, it } from 'vitest';
import { GroundTriangles, makeFrame, triangleInterval, planePoint, screenRay, measureContacts,measureWaterJunctions } from './contactGeometry.js';

const frame = makeFrame([0,0,110],100);
const water = { normal:[0,0,1],d:101 };
const mesh = () => new GroundTriangles(frame,[-10,-10,10,10]);
describe('visible lake-river junction heights',()=>{
    const sample=z=>measureWaterJunctions({positions:new Float32Array([0,0,0,2,1,0,z-100,-1]),
        dxField:new Float32Array([1,0,0,0,1,0,0,0]),dyField:new Float32Array([0,1,0,0,0,1,0,0]),
        width:2,height:1,camera:[0,0,100],origin:[0,0,0],nearM:100});
    it('accepts matching heights at a shared visible boundary',()=>{expect(sample(100).maxAbsoluteStepM).toBe(0);});
    it('detects a lower river even when the water union has no shoreline gap',()=>{
        const r=sample(99);expect(r.over25cm).toBe(1);expect(r.maxAbsoluteStepM).toBeCloseTo(1,3);
    });
});
function patch(g,x0,x1,z0,z1) {
    const a=[x0,-5,z0],b=[x1,-5,z1],c=[x1,5,z1],d=[x0,5,z0];
    g.add(a,b,c);g.add(a,c,d);
}

describe('rendered triangle shoreline contact', () => {
    it('measures an exposed one-metre water drop against rendered triangles', () => {
        const g=mesh();patch(g,-5,5,100,100);
        const span=g.span([-1,0],[1,0],water);
        expect(span.covered).toBe(true);
        expect(span.dropM).toBeCloseTo(1,8);
        expect(span.minDropM).toBeCloseTo(1,8);
    });
    it('recognises actual ground crossing the water plane', () => {
        const g=mesh();patch(g,-5,5,99,103);
        const span=g.span([-1,0],[1,0],water);
        expect(span.covered).toBe(true);
        expect(span.minDropM).toBeLessThan(0);
        expect(span.maxDropM).toBeGreaterThan(0);
    });
    it('catches a narrow dry sill between two submerged pixel centres', () => {
        const g=mesh();patch(g,-5,-.05,100,100);patch(g,-.05,0,100,102);
        patch(g,0,.05,102,100);patch(g,.05,5,100,100);
        const span=g.span([-1,0],[1,0],water);
        expect(span.covered).toBe(true);
        expect(span.minDropM).toBeCloseTo(-1,8);
        expect(span.maxDropM).toBeGreaterThan(.99);
    });
    it('bounds an interior separation minimum that endpoint and midpoint samples miss', () => {
        const g=new GroundTriangles(frame,[-100,-100,100,100]);
        g.add([-100,-100,100],[100,-100,100],[0,100,100]);
        const span=g.span([-10,0],[20,0],{normal:[0,0,1],d:100.04997});
        expect(span.covered).toBe(true);
        expect(span.dropM).toBeGreaterThan(.05);
        expect(span.minDropM).toBeCloseTo(.04997,8);
        expect(span.minDropM).toBeLessThan(.05);
    });
    it('does not certify missing terrain between the sample endpoints', () => {
        const g=mesh();patch(g,-5,-.1,100,100);patch(g,.1,5,100,100);
        expect(g.span([-1,0],[1,0],water).covered).toBe(false);
    });
    it('uses the actual triangle diagonal for a saddle', () => {
        const a=[-1,-1,100],b=[1,-1,102],c=[1,1,100],d=[-1,1,102];
        const low=mesh();low.add(a,b,c);low.add(a,c,d);
        const high=mesh();high.add(a,b,d);high.add(b,c,d);
        expect(low.span([0,0],[.001,.001],water).dropM).toBeGreaterThan(.99);
        expect(high.span([0,0],[.001,.001],water).dropM).toBeLessThan(-.99);
    });
    it('clips a segment exactly and rejects a water plane behind the camera', () => {
        const interval=triangleInterval([-1,.25],[2,.25],[0,0],[1,0],[0,1]);
        expect(interval[0]).toBeCloseTo(1/3,7);expect(interval[1]).toBeCloseTo(1.75/3,7);
        expect(planePoint([0,0,1],[0,0,110],water)).toBeNull();
        expect(planePoint([0,0,-1],[0,0,110],water)).toEqual([0,0,101]);
    });
});

describe('visible shoreline classification', () => {
    function capture(kind=2,groundZ=100,neighbourZ=100,includeGround=true) {
        const camera=[0,0,110],inv=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
        const p=planePoint(screenRay(.5,.5,3,1,inv,camera),camera,water),g=mesh();
        if(includeGround)patch(g,-5,5,groundZ,groundZ);
        return measureContacts({positions:new Float32Array([p[0],p[1],p[2]-110,kind,0,0,neighbourZ-110,1,0,0,neighbourZ-110,1]),
            dxField:new Float32Array([.055,0,0,0,0,0,0,0,0,0,0,0]),dyField:new Float32Array([0,-.1,0,0,0,0,0,0,0,0,0,0]),width:3,height:1,ground:g,camera,origin:[0,0,0],invViewProjection:inv,nearM:100});
    }
    it('counts the same exposed edge for a pure lake and a river', () => {
        expect(capture(2).summary.lake.hangingGridEdges).toBe(1);
        expect(capture(-1).summary.river.hangingGridEdges).toBe(1);
    });
    it('excludes foreground occlusion and accepts contact within the stated tolerance', () => {
        expect(capture(2,100,102).counts.occluded).toBe(1);
        expect(capture(2,100.98,100.98).counts.contact).toBe(1);
    });
    it('reports unavailable terrain as unresolved rather than declaring contact', () => {
        expect(capture(2,100,100,false).counts.unknown).toBe(1);
    });
});
