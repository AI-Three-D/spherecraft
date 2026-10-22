// Fixed-resolution source experiment. No selected-mesh input or terrain edits.
import {TileGenerator} from '../../../core/world/quadtree/tileGenerator.js';
import {TileAddress} from '../../../core/world/quadtree/tileAddress.js';
import {WaterPageCache} from '../../../core/world/water/WaterPageCache.js';
import {faceUVToDir,dirToFaceUV} from '../../../core/world/hydrology/waterGraph.js';
import {lakeMaskSdf,lakeSdfAt} from '../../../core/world/water/lakeMaskSdf.js';
import {dot,norm} from './contactGeometry.js';
import {connectDepths,clipWet,buildBodyMask,packBodyMask,bodyMaskWgsl} from './bodyMask.js';
import {terrainClone,nearClone,patchQueries} from './connectedPrototype.js';
import {finalHeightGrid,heightBlocks} from './finalHeightBlocks.js';
import {packSparseLakeMask,sparseLakeWgsl} from './sparseLakeMask.js';

async function readHeight(d,texture,n) {
    const pitch=Math.ceil(n*4/256)*256,read=d.createBuffer({size:pitch*n,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try {
        const enc=d.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:pitch},[n,n]);d.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);const src=new Float32Array(read.getMappedRange()),out=new Float32Array(n*n);
        for(let y=0;y<n;y++)out.set(src.subarray(y*pitch/4,y*pitch/4+n),y*n);read.unmap();return out;
    } finally {read.destroy();}
}

export async function installFinalHeightLake(lakeId,{bandM=64,rangeM=1100,indexedOnly=false,sparse=false}={}) {
    const started=Date.now(),g=window.gameEngine,f=g.renderer,w=g.waterGpuData,t=f.quadtreeTerrainRenderer,n=f.nearWaterRenderer,b=f.backend,d=b.device;
    const tm=f.quadtreeTileManager,s=tm.tileStreamer,R=w.R,N=s.tileTextureSize;
    const depth=Math.ceil(Math.log2(2*R/N)),D=2**depth; // <= 1 m nominal source spacing, independent of drawing depth.
    if(N!==128||s.textureFormats.height!=='r32float')throw new Error('This source experiment requires 128 texels and r32float');
    const rec=w._applied.get(lakeId),row=w._table.subarray(lakeId*16,lakeId*16+16),level=row[0];
    const frame={c:Array.from(row.subarray(4,7)),e1:Array.from(row.subarray(8,11)),e2:Array.from(row.subarray(12,15))};
    const project=p=>[dot(p,frame.e1)/dot(p,frame.c)*R,dot(p,frame.e2)/dot(p,frame.c)*R];
    const ray=xy=>norm(frame.c.map((v,k)=>v+(frame.e1[k]*xy[0]+frame.e2[k]*xy[1])/R));
    const cam=f.camera.position,o=g.planetConfig.origin,focus=project([cam.x-o.x,cam.y-o.y,cam.z-o.z]);
    // Whole test region is anchored to fixed 256 m blocks, not drawn tiles.
    const centre=focus.map(x=>Math.floor(x/256)*256+128),bounds=[centre[0]-rangeM,centre[1]-rangeM,centre[0]+rangeM,centre[1]+rangeM];
    const revision=JSON.stringify([w._appliedVersion,g.terrainGenerator.terrainConfig,depth,N]);
    const state=window.__finalLakeCache??= {
        heights:new WaterPageCache({maxBytes:32*1024*1024}),masks:new WaterPageCache({maxBytes:16*1024*1024}),
        generator:new TileGenerator(g.terrainGenerator,{textureSize:N,requiredTypes:['height'],textureFormats:s.textureFormats,
            quadtreeMaxDepth:depth,maxGeomLOD:tm.maxGeomLOD,enableSplat:false})};
    const cacheBefore={heights:state.heights.snapshot(),masks:state.masks.snapshot()},key=JSON.stringify([lakeId,bounds,bandM]);
    const product=await state.masks.get(key,revision,async()=>{
        const F=w._sdfCache?.get(rec)??lakeMaskSdf(rec.mask,rec.frame.nx,rec.frame.ny,rec.frame.spacing);
        const sdf=dir=>lakeSdfAt(F,rec.frame,dot(dir,rec.frame.e1)/dot(dir,rec.frame.c)*R,dot(dir,rec.frame.e2)/dot(dir,rec.frame.c)*R);
        const corners=[[bounds[0],bounds[1]],[bounds[0],bounds[3]],[bounds[2],bounds[1]],[bounds[2],bounds[3]]].map(p=>dirToFaceUV(ray(p)));
        if(new Set(corners.map(x=>x.face)).size!==1)throw new Error('Cube-face crossing needs regional page links before publication');
        const face=corners[0].face,lo=[Math.floor(Math.min(...corners.map(p=>p.u))*D),Math.floor(Math.min(...corners.map(p=>p.v))*D)],
            hi=[Math.floor(Math.max(...corners.map(p=>p.u))*D),Math.floor(Math.max(...corners.map(p=>p.v))*D)];
        const vertices=new Map(),triangles=[],depths=[],seeds=[],pages=[];let maxSeamHeightErrorM=0,sharedSamples=0,heightBuildMs=0,known=[];
        for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++) {
            let near=false;
            for(let j=0;j<=8;j++)for(let i=0;i<=8;i++)if(Math.abs(sdf(faceUVToDir(face,(x+i/8)/D,(y+j/8)/D)))<bandM+24)near=true;
            if(!near)continue;
            const addr=new TileAddress(face,depth,x,y),begin=Date.now();
            const heights=await state.heights.get(addr.toString(),revision,async()=>{
                const tx=await state.generator.generateTile(addr);
                try{return await readHeight(d,tx.height._gpuTexture.texture,N);}finally{Object.values(tx).forEach(t=>t?._gpuTexture?.texture?.destroy());}
            });heightBuildMs+=Date.now()-begin;pages.push(addr.toString());
            const grid=finalHeightGrid(heights,N,g.planetConfig.maxTerrainHeight);
            const vertex=(i,j)=>{
                const gx=x*N+i,gy=y*N+j,k=`${gx},${gy}`,h=grid[j*(N+1)+i];
                if(vertices.has(k)){const old=vertices.get(k);sharedSamples++;maxSeamHeightErrorM=Math.max(maxSeamHeightErrorM,Math.abs(old.h-h));return old;}
                const dir=faceUVToDir(face,gx/(N*D),gy/(N*D)),v={h,dir,p:dir.map(a=>a*(R+h)),xy:project(dir)};vertices.set(k,v);return v;
            };
            const include=(i,j,size)=>{
                const xy=project(faceUVToDir(face,(x+(i+size/2)/N)/D,(y+(j+size/2)/N)/D));
                const radius=size*R*2/(N*D),band=sdf(ray(xy));
                return !(xy[0]+radius<bounds[0]||xy[0]-radius>bounds[2]||xy[1]+radius<bounds[1]||xy[1]-radius>bounds[3]||Math.abs(band)>bandM+radius);
            };
            heightBlocks(grid,N,level,(i,j,size)=>{
                const v=[vertex(i,j),vertex(i+size,j),vertex(i,j+size),vertex(i+size,j+size)];
                for(const ids of[[0,2,1],[1,2,3]]) {
                    const vs=ids.map(k=>v[k]),ix=triangles.length;
                    triangles.push(vs.map(p=>p.p));depths.push(vs.map(p=>level-p.h));known.push({p:vs.map(p=>p.xy),known:true});
                    if(vs.some(p=>sdf(p.dir)>bandM/2&&level-p.h>.25))seeds.push(ix);
                }
            },{include});
        }
        const topology=connectDepths(triangles,depths,seeds),polygons=known;
        triangles.forEach((tr,i)=>{const p=clipWet(tr.map(project),depths[i]);if(p.length>=3)polygons.push({p,body:0,connected:!!topology.connected[i]});});
        const mask=buildBodyMask({polygons,bodies:[{at:()=>({level})}],bounds}),data=packBodyMask(mask,frame,R,lakeId,level,[]);
        if(w._appliedVersion!==JSON.parse(revision)[0])throw new Error('Hydrology changed during shore build');
        return {byteLength:data.byteLength,data,stats:{heightPages:pages.length,pages,heightBuildMs,fineSourceDepth:depth,
            upperSampleSpacingM:2*R/(D*N),sourceTriangles:triangles.length,seeds:seeds.length,seedComponents:topology.seedComponents,
            maxSeamHeightErrorM,sharedSamples,mask:mask.stats,buildMs:Date.now()-started,
            seedAssumption:'wet fine shore components touching the coarse interior half of the band; unsampled lake interior is retained'}};
    });
    const encoded=sparse?packSparseLakeMask(product.data):null,upload=encoded?.data??product.data;
    const buffer=d.createBuffer({size:upload.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(buffer,0,upload);
    const previous={terrain:t._materials,lake:n._lakeMaterial,river:n._riverMaterial,patch:w.connectedCoveragePatch};
    const opts={wgsl:sparse?sparseLakeWgsl:bodyMaskWgsl,patch:code=>patchQueries(code,{indexedOnly})},materials=new Map([...t._materials].map(([lod,m])=>[lod,terrainClone(b,m,buffer,opts)])),lake=nearClone(previous.lake,buffer,true,opts),river=nearClone(previous.river,buffer,false,opts);
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',product.data))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const metadata={mode:'final-height-lake',indexedOnly,sparse:encoded?.stats??null,body:lakeId,level,bounds,frame,sourceVersion:w._appliedVersion,maskSha256:hash,
        publicationMs:Date.now()-started,cacheBefore,cacheAfter:{heights:state.heights.snapshot(),masks:state.masks.snapshot()},...product.stats};
    window.__lastFinalLakeMetadata=metadata;
    w.connectedCoveragePatch={...metadata,buffer};t._materials=materials;n._lakeMaterial=lake;n._riverMaterial=river;
    window.__connectedPrototype={metadata,restore:async()=>{
        t._materials=previous.terrain;n._lakeMaterial=previous.lake;n._riverMaterial=previous.river;
        if(previous.patch===undefined)delete w.connectedCoveragePatch;else w.connectedCoveragePatch=previous.patch;
        await d.queue.onSubmittedWorkDone();for(const m of [...materials.values(),lake,river])b.destroyMaterial(m);buffer.destroy();delete window.__connectedPrototype;
    }};return metadata;
}
