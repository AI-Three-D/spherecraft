import { describe, expect, it } from 'vitest';
import { connectedBasinDistance, junctionWetUnion, solveJunctionField } from './junctionField.js';

function patch(width = 17, height = 13) {
    const n = width * height;
    return { width, height,
        natural: new Float64Array(n).fill(15),
        levelGuide: new Float64Array(n).fill(11),
        bedGuide: new Float64Array(n).fill(8),
        wetDistance: new Float64Array(n).fill(4),
        fixedLevel: new Uint8Array(n), fixedBed: new Uint8Array(n),
        options: { levelScreening: 0, bedScreening: 0, iterations: 3000, toleranceM: 1e-7 },
    };
}

describe('two-dimensional junction field', () => {
    it('extends lake distances beyond a clipped render mask without flooding a separate lower basin', () => {
        const width=21,height=11,natural=new Float64Array(width*height),seeds=new Uint8Array(width*height);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
            natural[y*width+x]=x===10?12:8;
            if(x<3&&y>2&&y<8)seeds[y*width+x]=1;
        }
        const r=connectedBasinDistance({width,height,spacingM:2,natural,levelM:10,seeds});
        for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
            expect(r.wet[y*width+x]).toBe(x<10?1:0);
            expect(r.distance[y*width+x]).toBe(2*(9.5-x));
        }
    });
    it('preserves constant level and bed without grid-direction artifacts', () => {
        const p = patch(), r = solveJunctionField(p);
        expect(r.converged).toBe(true);
        for (let i = 0; i < p.natural.length; i++) {
            expect(r.field[4*i]).toBe(11);
            expect(r.field[4*i+1]).toBe(8);
        }
    });

    it('connects prescribed lake and upstream levels without overshoot', () => {
        const p = patch();
        for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
            const i = y*p.width+x, level = 12 - 2*x/(p.width-1);
            p.levelGuide[i] = level;
            if (x === 0 || x === p.width-1) p.fixedLevel[i] = 1;
        }
        const r = solveJunctionField(p);
        expect(r.converged).toBe(true);
        for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
            const value = r.field[4*(y*p.width+x)];
            expect(value).toBeGreaterThanOrEqual(10);
            expect(value).toBeLessThanOrEqual(12);
            expect(value).toBeCloseTo(12-2*x/(p.width-1), 5);
        }
    });

    it('retains natural dry banks and never constructs terrain above natural ground', () => {
        const p = patch();
        for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
            const i = y*p.width+x;
            p.natural[i] = 7 + Math.sin(x*.4) + y*.08;
            p.wetDistance[i] = 3-Math.abs(y-(p.height-1)*.5);
            p.bedGuide[i] = 9; // deliberately above parts of the natural bed
        }
        const r = solveJunctionField(p);
        for (let i = 0; i < p.natural.length; i++) {
            expect(r.field[4*i+1]).toBeLessThanOrEqual(p.natural[i]+1e-6);
            if (p.wetDistance[i] <= 0) expect(r.field[4*i+1]).toBeCloseTo(p.natural[i], 5);
        }
    });

    it('preserves hydraulic depth through a narrow channel between high dry banks', () => {
        const p=patch(33,17);p.natural.fill(20);p.levelGuide.fill(10);p.bedGuide.fill(8);
        for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++)p.wetDistance[y*p.width+x]=1.5-Math.abs(y-8);
        const r=solveJunctionField(p);
        for(let y=7;y<=9;y++)for(let x=1;x+1<p.width;x++) {
            const i=y*p.width+x;
            expect(r.field[4*i]-r.field[4*i+1]).toBeGreaterThanOrEqual(2);
        }
    });

    it('permits a bounded dry-bank retreat without changing distant dry terrain', () => {
        const p=patch(33,33);p.natural.fill(20);p.levelGuide.fill(10);
        p.options.bankCollarM=5;
        for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++) {
            const i=y*p.width+x,d=2-Math.abs(y-16);
            p.wetDistance[i]=d;p.bedGuide[i]=d>0?8:Math.min(20,10-2*d);
        }
        const r=solveJunctionField(p),at=(x,y)=>r.field[4*(y*p.width+x)+1];
        expect(at(16,20)).toBeLessThan(20);
        expect(at(16,25)).toBe(20);
        for(let i=0;i<p.natural.length;i++)expect(r.field[4*i+1]).toBeLessThanOrEqual(20);
    });

    it('extends the surface across dry support vertices without changing prescribed wet levels', () => {
        const p=patch(33,17);p.natural.fill(20);p.levelGuide.fill(6);p.bedGuide.fill(4);
        for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++) {
            const i=y*p.width+x;p.wetDistance[i]=2-Math.abs(y-8);
            if(p.wetDistance[i]>0){p.levelGuide[i]=10;p.fixedLevel[i]=1;}
        }
        const r=solveJunctionField(p);
        for(let y=5;y<=11;y++)for(let x=1;x+1<p.width;x++)expect(r.field[4*(y*p.width+x)]).toBe(10);
    });

    it('rounds the union corner while preserving either distant domain exactly', () => {
        expect(junctionWetUnion(0, 0, 16)).toBeGreaterThan(0);
        expect(junctionWetUnion(20, -20, 16)).toBe(20);
        expect(junctionWetUnion(-20, 20, 16)).toBe(20);
        for (const d of [-30,-5,0,3,40]) {
            expect(junctionWetUnion(d, -d, 16)).toBe(junctionWetUnion(-d, d, 16));
        }
    });

    it('solves relative to a datum rather than losing small changes at planetary height', () => {
        const p = patch(), a = solveJunctionField(p), offset = 800;
        for (const key of ['natural','levelGuide','bedGuide']) p[key] = p[key].map(v => v+offset);
        const b = solveJunctionField(p);
        for (let i = 0; i < p.natural.length; i++) {
            expect(b.field[4*i]-offset).toBe(a.field[4*i]);
            expect(b.field[4*i+1]-offset).toBe(a.field[4*i+1]);
        }
    });

    it('keeps the screened bed shape when the spatial grid is refined', () => {
        const solveAt = width => {
            const p=patch(width,width),length=32,screening=.02;
            p.spacingM=length/(width-1);
            p.options={...p.options,bedScreening:screening,iterations:6000};
            for(let y=0;y<width;y++)for(let x=0;x<width;x++) {
                p.bedGuide[y*width+x]=8+2*Math.sin(Math.PI*x/(width-1))*Math.sin(Math.PI*y/(width-1));
            }
            const r=solveJunctionField(p);
            expect(r.converged).toBe(true);
            return r.field[4*((width>>1)*width+(width>>1))+1];
        };
        const coarse=solveAt(17),fine=solveAt(33);
        const expected=8+2*.02/(2*(Math.PI/32)**2+.02);
        expect(Math.abs(fine-expected)).toBeLessThan(.002);
        expect(Math.abs(fine-coarse)).toBeLessThan(.003);
    });
});
