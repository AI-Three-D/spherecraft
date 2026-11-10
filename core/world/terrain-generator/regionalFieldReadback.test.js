import {beforeAll,describe,expect,it} from 'vitest';
import {readRegionalField} from './regionalFieldReadback.js';

beforeAll(()=>{
    globalThis.GPUBufferUsage??={COPY_DST:2,MAP_READ:16};
    globalThis.GPUMapMode??={READ:1};
});
function deviceForReadback(fail=false) {
    const buffers=[],copies=[];
    return {buffers,copies,queue:{submit(){}},createBuffer({size}) {
        const b={bytes:new ArrayBuffer(size),mapState:'unmapped',destroyed:false,
            async mapAsync(){if(fail)throw new Error('Mapping failed');this.mapState='mapped';},
            getMappedRange(){return this.bytes;},unmap(){this.mapState='unmapped';},destroy(){this.destroyed=true;}};
        buffers.push(b);return b;
    },createCommandEncoder(){return {finish(){return {};},copyTextureToBuffer(source,dest,size) {
        copies.push({origin:source.origin,size,bytesPerRow:dest.bytesPerRow,rowsPerImage:dest.rowsPerImage});
        const t=source.texture,[ox,oy,face]=source.origin,out=new Float32Array(dest.buffer.bytes),stride=dest.bytesPerRow/4;
        for(let z=0;z<size[2];z++)for(let y=0;y<size[1];y++) {
            const start=(((face+z)*t.size+oy+y)*t.size+ox)*t.channels;
            out.set(t.values.subarray(start,start+size[0]*t.channels),(z*dest.rowsPerImage+y)*stride);
        }
    }};}};
}
const field=(size,channels)=>({size,channels,values:Float32Array.from({length:6*size*size*channels},(_,i)=>i)});

describe('regional texture window readback',()=>{
    it('preserves all receiver cells and their 4x4 halo across padded rows and array faces',async()=>{
        const device=deviceForReadback(),face=4,x=5,y=9,width=5;
        for(const channels of [1,4]) {
            const halo=channels===4?3:0,size=16+halo,texture=field(size,channels);
            const full=await readRegionalField(device,texture,{width:size,channels});
            const local=await readRegionalField(device,texture,{width:width+halo,channels,layers:1,origin:[x,y,face]});
            expect(local.values.byteLength).toBe((width+halo)**2*channels*4);
            expect(local.copyBytes).toBe((width+halo)*256);
            for(let j=0;j<width;j++)for(let i=0;i<width;i++)for(let dy=0;dy<=halo;dy++)for(let dx=0;dx<=halo;dx++)for(let c=0;c<channels;c++) {
                expect(local.values[((j+dy)*(width+halo)+i+dx)*channels+c]).toBe(full.values[((face*size+y+j+dy)*size+x+i+dx)*channels+c]);
            }
            expect(device.copies.at(-1)).toEqual({origin:[x,y,face],size:[width+halo,width+halo,1],bytesPerRow:256,rowsPerImage:width+halo});
        }
        expect(device.buffers.every(b=>b.destroyed&&b.mapState==='unmapped')).toBe(true);
    });
    it('releases staging memory when mapping fails',async()=>{
        const device=deviceForReadback(true);
        await expect(readRegionalField(device,field(16,1),{width:16,channels:1})).rejects.toThrow('Mapping failed');
        expect(device.buffers[0].destroyed).toBe(true);
    });
});
