import {describe,it,expect} from 'vitest';
import {riverMouthsFromTerrain,insertRiverMouthAnchors,riverMouthLevels,riverMouthAt,riverMouthShape,riverMouthIndexReach,lakeMouthSurface} from './riverMouth.js';

const R=10000,st=20;
function river() {
    const points=new Float32Array(17*st);
    for(let k=0;k<17;k++) {
        const x=k*20,t=x/R;
        points.set([Math.sin(t),0,Math.cos(t),10-x*.025,12,3],k*st);
        points[k*st+16]=points[k*st+3];
        points[k*st+9]=x<=60||x>=300?-1:0;
    }
    return {points,stride:st,src:0,dest:{type:'lake',id:1}};
}
const ground=d=>{const x=d[0]/d[2]*R;return x<=160?10+.05*(x-80):14-.1*(x-160);};

describe('river/lake junction publication',()=>{
    it('indexes a wide shallow fan beyond the ordinary channel support without widening the whole reach',()=>{
        const m={s:200,hw:40,level:10,sign:1,landM:144};
        const reach=riverMouthIndexReach(m,180,220,40,.6,150);
        // More than 250 m across at the broad end, plus a 48 m bank blend.
        expect(reach).toBeGreaterThan(290);
        expect(riverMouthIndexReach(m,0,20,40,.6,150)).toBe(150);
        expect(riverMouthIndexReach(m,320,340,40,.6,150)).toBe(150);
    });
    it('anchors both mouths on the terrain waterline rather than the coarse pool flags',()=>{
        const {mouths}=riverMouthsFromTerrain(river(),R,ground);
        expect(mouths).toHaveLength(2);
        expect(mouths.every(m=>m.shoreResolved)).toBe(true);
        expect(Math.abs(mouths[0].s-80)).toBeLessThan(.2);
        expect(Math.abs(mouths[1].s-280)).toBeLessThan(.2);
    });
    it('preserves downstream descent and lake levels, and applies the fit only once',()=>{
        const rec=river(),{mouths,arc}=riverMouthsFromTerrain(rec,R,ground);
        const before=Float64Array.from(arc,(_,k)=>rec.points[k*st+16]);
        const levels=riverMouthLevels({...rec,mouths},arc,before);
        expect(levels[0]).toBe(10);expect(levels.at(-1)).toBe(2);
        for(let k=1;k<levels.length;k++)expect(levels[k]).toBeLessThanOrEqual(levels[k-1]+1e-7);
        expect(riverMouthLevels({...rec,mouths,mouthLevelsBaked:true},arc,levels)).toBe(levels);
    });
    it('puts shoreline stations on a point without changing the rest of the path',()=>{
        // Both shores lie within 0.2 m of a point: the stations move onto
        // those points (MOUTH_ANCHOR_SNAP) rather than adding micro segments.
        const rec=river(),{mouths,arc}=riverMouthsFromTerrain(rec,R,ground);
        const shores=mouths.map(m=>m.s);
        const out=insertRiverMouthAnchors(rec,mouths,arc,R);
        expect(out.points.length).toBe(rec.points.length);
        mouths.forEach((m,i)=>{
            expect(out.arc[m.index]).toBe(m.s);
            expect(Math.abs(m.s-shores[i])).toBeLessThan(.2);
        });
        expect(Array.from(out.points)).toEqual(Array.from(rec.points));
    });
    it('makes adjacent mouth supports disjoint on a short reach',()=>{
        const rec=river(),{mouths}=riverMouthsFromTerrain(rec,R,ground);
        mouths[0].s=80;mouths[1].s=120;
        for(const m of mouths)m.landM=18;
        for(const s of [99.9,100,100.1]) {
            const m=riverMouthAt(mouths,s);
            expect(riverMouthShape(m,s,12).influence).toBe(0);
        }
    });
    it('extends the surface frame and region together, without flooding the descending reach',()=>{
        const rec=river(),{mouths,arc}=riverMouthsFromTerrain(rec,R,ground);rec.mouths=mouths;
        const frame={c:[0,0,1],e1:[1,0,0],e2:[0,1,0],x0:-100,y0:-60,nx:18,ny:12,spacing:10};
        const mask=Uint8Array.from({length:18*12},(_,k)=>k%18<17?2:0);
        const lake={frame,mask,level:10};
        const view=lakeMouthSurface(lake,0,[rec],R,()=>arc);
        const at=(x,y)=>{
            const f=view.frame,i=Math.floor((x-f.x0)/10),j=Math.floor((y-f.y0)/10);
            return i<0||j<0||i>=f.nx||j>=f.ny?0:view.mask[j*f.nx+i];
        };
        expect(view.frame.x0+view.frame.nx*10).toBeGreaterThan(80);
        expect(view.mouthCells.length).toBeGreaterThan(0);
        expect(at(75,0)).toBe(2);
        expect(at(85,0)).toBe(0);
        expect(at(-75,0)).toBe(2);
        expect(at(140,0)).toBe(0);
        expect(lake.frame).toBe(frame);expect(lake.mask).toBe(mask);
    });
});

describe('mouth anchors',()=>{
    it('moves a mouth station onto a nearby point instead of adding a micro segment',()=>{
        const R=131072,st=20,n=4,P=new Float32Array(n*st),arc=new Float64Array(n);
        for(let k=0;k<n;k++){const a=k*20/R;P.set([Math.cos(a),Math.sin(a),0],k*st);arc[k]=k*20;}
        const near={s:40.3,sign:1},mid={s:30,sign:1};
        const a=insertRiverMouthAnchors({points:P,stride:st},[near],arc,R);
        expect(a.arc.length).toBe(n);expect(near.s).toBeCloseTo(40,3);expect(near.index).toBe(2);
        const b=insertRiverMouthAnchors({points:P,stride:st},[mid],arc,R);
        expect(b.arc.length).toBe(n+1);expect(mid.s).toBeCloseTo(30,2);
        for(let q=0;q+1<b.arc.length;q++)expect(b.arc[q+1]-b.arc[q]).toBeGreaterThan(5);
    });
});
