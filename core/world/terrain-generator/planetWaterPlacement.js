import {readRegionalField} from './regionalFieldReadback.js';
import {createSingleRegionalShapeData} from './regionalShape.js';
import {faceUVToDir,dirToFaceUV,dirToCell} from '../hydrology/waterGraph.js';
import {planeToDir} from '../hydrology/lakeRefine.js';

export function isPlanetWaterSiteRejection(error) {
    return error instanceof Error&&[
        'No nearby certified receiver meets','Local basin search crosses','Regional receiver is unreachable',
        'Regional course self-intersects','Regional course anchor is outside certified lake depth','Regional course never exits its lake',
        'Regional course has insufficient dry reach',
        'Regional river course sampling budget exceeded','Coarse regional route exceeds',
        'Regional river profile sampling budget exceeded','Regional river profile point budget exceeded','Regional river profile exceeds incision budget',
        'Regional shape cannot preserve existing root height bounds',
    ].some(prefix=>error.message.startsWith(prefix));
}

export function planetWaterOptions(input={}) {
    const o={enabled:true,maxRegions:1100,maxCandidates:4096,maxLakes:1200,lakesPerRegion:1,maxRivers:320,shapeCells:64,giantLakes:10,largeLakes:64,riverProfileStepM:32,...input};
    if(!Number.isInteger(o.maxRegions)||o.maxRegions<1||o.maxRegions>1536
        ||!Number.isInteger(o.maxCandidates)||o.maxCandidates<o.maxRegions||o.maxCandidates>8192
        ||!Number.isInteger(o.maxRivers)||o.maxRivers<0||o.maxRivers>512
        ||!Number.isInteger(o.maxLakes)||o.maxLakes<1||o.maxLakes>4096
        ||!Number.isInteger(o.giantLakes)||o.giantLakes<0||o.giantLakes>24
        ||!Number.isInteger(o.largeLakes)||o.largeLakes<0||o.largeLakes>128
        ||!Number.isFinite(o.riverProfileStepM)||o.riverProfileStepM<16||o.riverProfileStepM>64
        ||o.shapeCells===256&&o.maxRegions>448
        ||!Number.isInteger(o.lakesPerRegion)||o.lakesPerRegion<1||o.lakesPerRegion>16||![64,128,256].includes(o.shapeCells)
)throw new Error('Invalid planet water work budget');
    return o;
}

// Select independent canonical regions across all six faces. The fields are
// generation inputs, not finished render tiles. Round-robin faces and sectors
// prevent one broad plateau from consuming the entire planet's work budget.
export function selectPlanetWaterRegions({a,b,cells,size,maxCandidates,heightScale,shelfM}) {
    const byFace=Array.from({length:6},()=>[]),grid=64;
    for(let face=0;face<6;face++)for(let y=4;y<grid-4;y++)for(let x=4;x<grid-4;x++) {
        const k=(face*size*size+Math.floor((y+.5)*cells/grid)*size+Math.floor((x+.5)*cells/grid))*4;
        const elevation=a[k+3]*shelfM+b[k+2]*heightScale,rough=Math.max(a[k+2],b[k+3]);
        if(a[k]<.65||elevation<120||!Number.isFinite(elevation))continue;
        const gentle=rough<.32,sector=Math.floor(y/4)*16+Math.floor(x/4);
        byFace[face].push({face,depth:gentle?6:7,x:gentle?x:x*2,y:gentle?y:y*2,
            parentX:x,parentY:y,sector,gentle,elevation,rough,score:rough*200+((x*73+y*151+face*199)%997)/997});
    }
    const lists=byFace.map(list=>{
        list.sort((x,y)=>x.score-y.score||x.y-y.y||x.x-y.x);
        const sectors=new Map();for(const p of list){if(!sectors.has(p.sector))sectors.set(p.sector,[]);sectors.get(p.sector).push(p);}
        const out=[];for(let row=0;out.length<list.length;row++)for(const q of sectors.values())if(q[row])out.push(q[row]);
        return out;
    });
    const out=[];for(let row=0;out.length<maxCandidates;row++) {
        let added=false;for(const list of lists)if(list[row]&&out.length<maxCandidates){out.push(list[row]);added=true;}
        if(!added)break;
    }
    return out;
}

// One 2D atlas keeps the existing terrain/selection binding layout. Its first
// rows are a direct canonical-region directory, then per-region parameters,
// then independent spline patches including their original halos.
export function planetWaterAtlasChunks(regions,_cells,planetRadius=131072) {
    const grid=128,width=2048,indexRows=Math.ceil(6*grid*grid/width),recordStride=5;
    const metadataRows=Math.ceil(Math.max(1,regions.length)*recordStride/width),header=indexRows+metadataRows;
    let x=0,y=header,rowHeight=0;
    const offsets=new Array(regions.length);
    // Pack larger images together; mixed row heights otherwise waste most
    // of the shelf when many small fields share a row with a large one.
    const packingOrder=regions.map((r,id)=>({id,side:r.options.cells+3})).sort((a,b)=>b.side-a.side||a.id-b.id);
    for(const {id,side} of packingOrder){if(x+side>width){x=0;y+=rowHeight;rowHeight=0;}
        offsets[id]=[x,y];x+=side;rowHeight=Math.max(rowHeight,side);}
    const height=y+Math.max(1,rowHeight),directory=new Int32Array(6*grid*grid).fill(-1);
    const index=new Float32Array(width*indexRows*4),metadata=new Float32Array(width*metadataRows*4);
    regions.forEach((r,id)=>{
        const o=r.options,scale=grid/2**o.depth;
        for(let j=o.y*scale;j<(o.y+1)*scale;j++)for(let i=o.x*scale;i<(o.x+1)*scale;i++) {
            const k=(o.face*grid+j)*grid+i;if(directory[k]>=0)throw new Error('Overlapping planet shape regions');
            directory[k]=id;index[k*4]=id+1;
        }
        metadata.set(r.parameters,id*20);metadata.set(offsets[id],id*20+16);
    });
    function* chunks() {
        yield {values:index,width,height:indexRows,x:0,y:0};
        yield {values:metadata,width,height:metadataRows,x:0,y:indexRows};
        for(let id=0;id<regions.length;id++) {
            const r=regions[id],n=r.options.cells,side=n+3,[ox,oy]=offsets[id];
            const values=new Float32Array(side*side*4),shoreCells=Math.max(1,Math.min(4,Math.ceil(25*2**r.options.depth*n/(planetRadius*1.6))));
            const micro=r.micro??new Uint8Array(side*side),plan=r.lakePlan,shore=new Float32Array(side*side),shoreLevels=new Float32Array(side*side);
            const owned=r.ownership??plan.region;
            for(let k=0;k<owned.length;k++)if(owned[k]) {
                const x=k%n,y=Math.floor(k/n),level=r.levels?.[k]??r.basin.levelM;
                for(let dy=-shoreCells;dy<=shoreCells;dy++)for(let dx=-shoreCells;dx<=shoreCells;dx++) {
                    const i=x+dx,j=y+dy;if(i<0||j<0||i>=n||j>=n)continue;
                    const weight=Math.max(0,1-Math.hypot(dx,dy)/(shoreCells+1)),q=j*side+i;
                    if(weight>shore[q]){shore[q]=weight;shoreLevels[q]=level;}
                }
            }
            for(let k=0;k<plan.region.length;k++)if(!r.micro&&plan.region[k]) {
                const x=k%n,y=Math.floor(k/n);
                for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(let b=0;b<4;b++)for(let a=0;a<4;a++)micro[(y+dy+b)*side+x+dx+a]=1;
            }
            for(let y=0;y<side;y++)for(let x=0;x<side;x++) {
                const k=y*side+x,z=k*4;
                values[z]=r.controls[k];values[z+1]=micro[k]+(x<n&&y<n&&owned[y*n+x]?2:0);
                values[z+2]=shoreLevels[k];values[z+3]=shore[k];
            }
            yield {values,width:side,height:side,x:ox,y:oy};
        }
    }
    return {chunks,width,height,grid,header,indexRows,recordStride,offsets,directory};
}

// Reference packing for audits. Runtime uploads the same texels in bounded
// batches, without keeping a second full atlas in JavaScript memory.
export function packPlanetWaterAtlas(regions,cells) {
    const packed=planetWaterAtlasChunks(regions,cells),values=new Float32Array(packed.width*packed.height*4);
    for(const chunk of packed.chunks())for(let y=0;y<chunk.height;y++)
        values.set(chunk.values.subarray(y*chunk.width*4,(y+1)*chunk.width*4),((chunk.y+y)*packed.width+chunk.x)*4);
    return {...packed,values};
}

export function planetShapeOwnership(directory,grid,radius) {
    return (dir,marginM=0)=>{
        const p=dirToFaceUV(dir),x=p.u*grid,y=p.v*grid;
        const margin=marginM*grid/radius*3+1e-6;
        for(let j=Math.max(0,Math.floor(y-margin));j<=Math.min(grid-1,Math.floor(y+margin));j++)
            for(let i=Math.max(0,Math.floor(x-margin));i<=Math.min(grid-1,Math.floor(x+margin));i++)if(directory[(p.face*grid+j)*grid+i]>=0)return true;
        return false;
    };
}

export function planetBasinDirectory(directory,grid,basins,radius) {
    const values=new Float32Array(6*grid*grid*4);
    for(let k=0;k<directory.length;k++)values[k*4]=directory[k]+1;
    basins.forEach((b,id)=>{
        const p=dirToFaceUV(b.centre),margin=b.radiusM*1.6*grid/radius*3+1e-6;
        for(let y=Math.max(0,Math.floor(p.v*grid-margin));y<=Math.min(grid-1,Math.floor(p.v*grid+margin));y++)
            for(let x=Math.max(0,Math.floor(p.u*grid-margin));x<=Math.min(grid-1,Math.floor(p.u*grid+margin));x++) {
                const k=((p.face*grid+y)*grid+x)*4;let slot=1;while(slot<4&&values[k+slot]!==0)slot++;
                if(slot===4)throw new Error('Planet basin directory overflow');values[k+slot]=id+1;
            }
    });
    return values;
}

// The existing hot shader path has two lake slots per coarse lookup cell.
// Respect that at placement time, including each potential shoreline cell,
// so no published lake silently disappears when several small ponds cluster.
export function retainPlanetLakeFootprints(region,occupancy,gridN,radius) {
    const retained=[],plans=[];let rejected=0;
    region.basins.forEach((b,i)=>{
        const cells=new Set(),f=b.frame;
        for(let y=0;y<f.ny;y++)for(let x=0;x<f.nx;x++)if(b.mask[y*f.nx+x])
            cells.add(dirToCell(planeToDir(f.x0+(x+.5)*f.spacing,f.y0+(y+.5)*f.spacing,f,radius),gridN));
        if([...cells].some(k=>(occupancy.get(k)??0)>=2)){rejected++;return;}
        for(const k of cells)occupancy.set(k,(occupancy.get(k)??0)+1);
        retained.push(b);plans.push(region.lakePlans[i]);
    });
    if(rejected) {
        region.ownership.fill(0);region.levels.fill(0);region.micro.fill(0);const n=region.options.cells,stride=n+3;
        for(const p of plans)for(let k=0;k<p.region.length;k++)if(p.region[k]) {
            region.ownership[k]=1;region.levels[k]=p.levelM;const x=k%n,y=Math.floor(k/n);
            for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(let b=0;b<4;b++)for(let a=0;a<4;a++)region.micro[(y+dy+b)*stride+x+dx+a]=1;
        }
        region.basins=retained;region.basin=retained[0]??null;region.lakePlans=plans;region.lakePlan=plans[0]??{rejected:true};
    }
    return rejected;
}

export async function createPlanetWaterShapes({device,gen,data,uniformBytes,options,waterEnabled}) {
    const started=performance.now(),o=planetWaterOptions(options),regions=[],attempts=[],occupancy=new Map();
    const ar=await readRegionalField(device,data.fields[0],{width:data.size,channels:4});
    const br=await readRegionalField(device,data.fields[1],{width:data.size,channels:4});
    const view=new DataView(uniformBytes),maxHeight=view.getFloat32(184,true);
    const candidates=selectPlanetWaterRegions({a:ar.values,b:br.values,cells:data.cells,size:data.size,maxCandidates:o.maxCandidates,
        heightScale:maxHeight,shelfM:.14*Math.min(5,Math.max(0,view.getFloat32(192,true)))*maxHeight});
    let texture,params;
    try {
        const centres=candidates.map(c=>faceUVToDir(c.face,(c.x+.5)/2**c.depth,(c.y+.5)/2**c.depth));
        const available=new Uint8Array(candidates.length).fill(1),nearest=new Float64Array(candidates.length).fill(4);
        for(let trial=0;trial<candidates.length;trial++) {
            if(regions.length>=o.maxRegions||regions.reduce((s,r)=>s+r.basins.length,0)>=o.maxLakes)break;
            // Incremental farthest-site order spreads the expensive fields
            // over available land. It requires only directions, never another
            // terrain pass or a camera-dependent placement search.
            let selected=-1,score=-1;
            for(let i=0;i<candidates.length;i++)if(available[i]&&nearest[i]>score){selected=i;score=nearest[i];}
            if(selected<0)break;available[selected]=0;const c=candidates[selected];
            if(regions.some(r=>r.parent.face===c.face&&r.parent.parentX===c.parentX&&r.parent.parentY===c.parentY))continue;
            const seed=(c.face*8191+c.x*131+c.y*17)%65536;
            const giant=c.gentle&&trial<120&&regions.filter(r=>r.parent.tier==='giant').length<o.giantLakes;
            const large=c.gentle&&!giant&&trial<400&&regions.filter(r=>r.parent.tier==='large').length<o.largeLakes;
            const depth=giant?3:large?4:c.gentle?6:c.depth;
            const x=giant?Math.floor(c.parentX/8):large?Math.floor(c.parentX/4):c.gentle?c.parentX:c.x;
            const y=giant?Math.floor(c.parentY/8):large?Math.floor(c.parentY/4):c.gentle?c.parentY:c.y;
            const scale=128/2**depth;
            if(x<1||y<1||x>=2**depth-1||y>=2**depth-1)continue;
            if(regions.some(r=>r.options.face===c.face&&x*scale<(r.options.x+1)*128/2**r.options.depth
                &&(x+1)*scale>r.options.x*128/2**r.options.depth&&y*scale<(r.options.y+1)*128/2**r.options.depth
                &&(y+1)*scale>r.options.y*128/2**r.options.depth))continue;
            const radiusM=giant?9000+seed%1800:large?1400+seed%2200:200+900*((seed%997)/996)**1.6;
            const config={enabled:true,face:c.face,depth,x,y,cells:giant||large?256:c.gentle?128:o.shapeCells,minLevelM:100,minimumEnclosureM:0,
                maxRadiusM:giant?18000:large?6500:c.gentle?2200:1000,maxPotentialCells:giant||large?50000:c.gentle?8192:4096,minWetCells:giant?200:large?80:c.gentle?12:6,
                surfaceCells:giant||large?256:128,microLimitM:.5,depthM:1.5,
                ...(c.gentle?{depression:{radiusM,maxCutM:giant?80:large?24:12,depthM:giant?8:large?4:2.5,seed,profile:'organic'}}:{}),
                multipleLakes:1};
            c.tier=giant?'giant':large?'large':c.gentle?'medium':'small';
            let r;
            try{r=await createSingleRegionalShapeData({device,gen,data,uniformBytes,options:config,waterEnabled});}
            catch(error){if(!isPlanetWaterSiteRejection(error))throw error;attempts.push({candidate:c,accepted:false,reason:error.message,timings:error.timings});continue;}
            const crowdedLakes=retainPlanetLakeFootprints(r,occupancy,gen.terrainConfig.waterGraph?.gridN??512,gen.planetConfig.radius);
            attempts.push({candidate:c,accepted:!!r.basin,crowdedLakes,timings:r.timings,rejection:r.lakePlan.rejected? r.lakePlan.attempts:null});
            // All GPU field work/readback has finished; only CPU controls
            // are needed to publish the atlas. Do not retain hundreds of images.
            r.destroy();
            if(!r.basin)continue;
            r.parent=c;const firstId=regions.reduce((s,r)=>s+r.basins.length,0);r.basins.forEach((b,i)=>b.id=firstId+i);regions.push(r);
            for(let i=0;i<candidates.length;i++)if(available[i])for(const b of r.basins) {
                const d=centres[i];nearest[i]=Math.min(nearest[i],Math.max(0,2-2*(d[0]*b.centre[0]+d[1]*b.centre[1]+d[2]*b.centre[2])));
            }
        }
        const packed=planetWaterAtlasChunks(regions,o.shapeCells,gen.planetConfig.radius),atlasBytes=packed.width*packed.height*16;
        if(packed.height>device.limits.maxTextureDimension2D)throw new Error('Planet water atlas exceeds adapter texture limit');
        let uploadBatchBytes=0,peakUploadBatchBytes=0,atlasUploadBytes=0;
        texture=device.createTexture({label:'Planet water generation atlas',size:[packed.width,packed.height],format:'rgba32float',
            usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
        params=device.createBuffer({label:'Planet shape atlas parameters',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        const parameters=new Float32Array([6,packed.grid,packed.width,packed.indexRows,o.shapeCells,8,waterEnabled?1:0,
            data.budgets.microM>0?Math.min(1,.25/data.budgets.microM):1,0,1.5,.25,.125,packed.header,regions.length,-2,.5]);
        device.queue.writeBuffer(params,0,parameters);
        for(const chunk of packed.chunks()) {
            device.queue.writeTexture({texture,origin:[chunk.x,chunk.y]},chunk.values,{bytesPerRow:chunk.width*16},[chunk.width,chunk.height]);
            uploadBatchBytes+=chunk.values.byteLength;atlasUploadBytes+=chunk.values.byteLength;
            peakUploadBatchBytes=Math.max(peakUploadBatchBytes,uploadBatchBytes);
            // Bound staging copies to ~4 MB rather than a full ~149 MB atlas.
            if(uploadBatchBytes>=4*1024*1024){await device.queue.onSubmittedWorkDone();uploadBatchBytes=0;}
        }
        await device.queue.onSubmittedWorkDone();
        // The atlas owns the published GPU payload; discard individual images.
        for(const r of regions)r.destroy();
        const descriptors=regions.map(r=>({options:r.options,parent:r.parent,parameters:r.parameters,basin:r.basin,basins:r.basins,
            lakePlan:{core:r.lakePlan.core,seed:r.lakePlan.seed,proof:r.lakePlan.proof},
            cpuBytes:r.parameters.byteLength+r.basins.reduce((s,b)=>s+b.mask.byteLength+(b.surfaceDepthMask?.byteLength??0),0)}));
        // Generation-only controls, ownership grids and cell-hull workspaces
        // have been published to the immutable GPU atlas. Retain the water
        // descriptions/masks, rather than another CPU terrain representation.
        for(const r of regions){r.controls=null;r.ownership=null;r.levels=null;r.micro=null;r.lakePlans=null;r.lakePlan=null;}
        const directory=packed.directory,grid=packed.grid;
        return {worldwide:true,options:o,texture,params,parameters,patches:descriptors,basins:descriptors.flatMap(r=>r.basins),
            ownsDirection:planetShapeOwnership(directory,grid,gen.planetConfig.radius),
            publishBasinIndex(basins) {
                const values=planetBasinDirectory(directory,grid,basins,gen.planetConfig.radius);
                device.queue.writeTexture({texture},values,{bytesPerRow:packed.width*16},[packed.width,packed.indexRows]);
                return values.byteLength;
            },
            byteLength:atlasBytes+64,cpuBytes:packed.directory.byteLength+descriptors.reduce((s,r)=>s+r.cpuBytes,0),
            timings:{totalMs:performance.now()-started,candidates:candidates.length,attempts,
                uploadBytes:atlasUploadBytes+64+attempts.reduce((s,r)=>s+r.timings.uploadBytes,0),
                readbackBytes:ar.values.byteLength+br.values.byteLength+attempts.reduce((s,r)=>s+r.timings.readbackBytes,0),atlasBytes,atlasUploadBytes,peakUploadBatchBytes},
            destroy(){texture.destroy();params.destroy();}};
    }catch(error){for(const r of regions)r.destroy();texture?.destroy();params?.destroy();throw error;}
}

export function sourceRegionReachM(region,source,radius) {
    const o=region.options,g=2**o.depth;
    return Math.max(...[0,1].flatMap(x=>[0,1].map(y=>{
        const d=faceUVToDir(o.face,(o.x+x)/g,(o.y+y)/g),den=d.reduce((s,v,k)=>s+v*source.centre[k],0);
        return radius*Math.hypot(...d.map((v,k)=>v-source.centre[k]*den))/den;
    })));
}
