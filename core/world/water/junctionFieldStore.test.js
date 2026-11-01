import { expect,it } from 'vitest';
import { packJunctionFields,JUNCTION_FIELD_CAPACITY,JUNCTION_FIELD_HEADER_BYTES } from './junctionFieldStore.js';

const field=(lakeId,width=5,height=7)=>({lakeId,frame:{c:[1,0,0],e1:[0,1,0],e2:[0,0,1],x0:-4,y0:-6,width,height,spacingM:2},
    field:new Float32Array(width*height*4).fill(lakeId)});

it('packs differently sized patches with exact cell offsets and lake ownership',()=>{
    const a=field(9),b=field(123,8,6),p=packJunctionFields([a,b],131072);
    const u=new Uint32Array(p.header),f=new Float32Array(p.header);
    expect(p.header.byteLength).toBe(JUNCTION_FIELD_HEADER_BYTES);expect(u[0]).toBe(2);
    expect(Array.from(u.slice(20,24))).toEqual([0,35,10,0]);
    expect(Array.from(u.slice(40,44))).toEqual([35,48,124,0]);
    expect(Array.from(f.slice(36,40))).toEqual([8,6,2,1]);
    expect(p.texels[35*4-1]).toBe(9);expect(p.texels[35*4]).toBe(123);
});

it('provides valid empty resources and rejects over-capacity or malformed patches',()=>{
    const empty=packJunctionFields([],131072);
    expect(new Uint32Array(empty.header)[0]).toBe(0);expect(empty.texels.byteLength).toBe(16);
    expect(()=>packJunctionFields(Array.from({length:JUNCTION_FIELD_CAPACITY+1},()=>field(1)),131072)).toThrow('capacity');
    expect(()=>packJunctionFields([{...field(1),field:new Float32Array(4)}],131072)).toThrow('dimensions');
});
