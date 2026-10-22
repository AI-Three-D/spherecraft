// Browser-only, opt-in diagnostic. No production shaders or world data change.
import {GroundTriangles,makeFrame,measureContacts,measureWaterJunctions,triangleInterval,sub,norm,dot} from './contactGeometry.js';
import {screenGapRuns} from './screenGaps.js';

async function readBuffer(device,buffer,size=buffer.size) {
    const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,0,read,0,size);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const data=read.getMappedRange().slice(0);read.unmap();read.destroy();return data;
}

function target(device,w,h) {
    const color=device.createTexture({size:[w,h],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
    const depth=device.createTexture({size:[w,h],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    return {width:w,height:h,_needsSetup:false,_gpuRenderTarget:{colorViews:[color.createView()],depthView:depth.createView()},color,depth};
}

async function readTexture(device,rt) {
    const pitch=Math.ceil(rt.width*16/256)*256,size=pitch*rt.height;
    const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:rt.color},{buffer:read,bytesPerRow:pitch},[rt.width,rt.height]);
    device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const data=new Float32Array(rt.width*rt.height*4),src=new Float32Array(read.getMappedRange());
    for(let y=0;y<rt.height;y++)data.set(src.subarray(y*pitch/4,y*pitch/4+rt.width*4),y*rt.width*4);
    read.unmap();read.destroy();return data;
}

const vec=a=>`vec3<f32>(${a.map(x=>`${x.toFixed(9)}`).join(',')})`;

function terrainMaterial(backend,original,geometry,args,camera,normalPass,allocations,owners=false) {
    const m=original.clone();m._chunkTextureFormats=original._chunkTextureFormats;
    m.targetFormat='rgba32float';m.transparent=false;m.depthWrite=true;m.asyncCompile=false;
    if(!m.fragmentShader.includes('@fragment\nfn main(input: FragmentInput) -> @location(0) vec4<f32>'))throw new Error('Terrain fragment signature changed');
    // Keep the original material's discard semantics, including missing micro
    // material; replace only the output. Ordinary lighting is dead-code eliminated.
    m.fragmentShader=m.fragmentShader.replace('@fragment\nfn main(input: FragmentInput) -> @location(0) vec4<f32>',
        'fn contactOriginal(input: FragmentInput) -> vec4<f32>')+`
@fragment fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    let originalColour=contactOriginal(input);
    return ${owners?'originalColour':`vec4<f32>(input.vWorldPosition-${vec(camera)},1.0)`};
}`;
    if(normalPass)return {m};
    return {m,original,geometry,args:Array.from(args)};
}

// Execute the unchanged vertex function in compute: WebGPU forbids writable
// vertex-stage storage. Use the exact selected instances, UVs and index list.
function exportVertices(b,item,allocations) {
    const {original,geometry,args}=item,d=b.device;
    const vertices=geometry.attributes.get('position').count,instances=args[1],first=args[4],size=vertices*instances*16;
    if(size>d.limits.maxStorageBufferBindingSize)throw new Error(`Vertex export exceeds binding limit: ${size}`);
    const buffer=d.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});allocations.push(buffer);
    const uv=geometry.attributes.get('uv').data;
    const uvBuffer=d.createBuffer({size:uv.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});allocations.push(uvBuffer);d.queue.writeBuffer(uvBuffer,0,uv);
    let code=original.vertexShader.replace('@vertex\nfn main(', 'fn contactVertex(')
        .replace('@builtin(instance_index) instanceIdx','instanceIdx')
        .replace('@group(1) @binding(0)', '@group(0) @binding(1)')
        .replace('@group(3) @binding(0)', '@group(0) @binding(2)');
    if(!code.includes('fn contactVertex('))throw new Error('Terrain vertex signature changed');
    if([...original.vertexShader.matchAll(/input\.(\w+)/g)].some(m=>m[1]!=='uv'))throw new Error('Vertex export must supply additional input attributes');
    code+=`
@group(0) @binding(3) var<storage,read_write> contactVertices:array<vec4<f32>>;
@group(0) @binding(4) var<storage,read> contactUV:array<vec2<f32>>;
@compute @workgroup_size(64) fn contactExport(@builtin(global_invocation_id) id:vec3<u32>) {
    if(id.x>=${vertices}u || id.y>=${instances}u){return;}
    var input:VertexInput;input.position=vec3<f32>(0.0);input.normal=vec3<f32>(0.0);input.uv=contactUV[id.x];
    let output=contactVertex(input,id.y+${first}u);
    contactVertices[id.y*${vertices}u+id.x]=vec4<f32>(output.vWorldPosition,1.0);
}`;
    const pipeline=d.createComputePipeline({layout:'auto',compute:{module:d.createShaderModule({code}),entryPoint:'contactExport'}});
    const uniforms=b._getMaterialBindGroupCache(original).get('terrain_g0'),tex=original.uniforms.heightTexture.value;
    const storage=original.storageBuffers.chunkInstances;
    const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:uniforms.vert}},
        {binding:1,resource:tex._gpuTexture['_view_2d-array']},
        {binding:2,resource:{buffer:storage.gpuBuffer||storage}},
        {binding:3,resource:{buffer}},{binding:4,resource:{buffer:uvBuffer}}]});
    const encoder=d.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);
    pass.dispatchWorkgroups(Math.ceil(vertices/64),instances);pass.end();d.queue.submit([encoder.finish()]);
    return {buffer,vertices,instances,indices:geometry.index.data.subarray(args[2],args[2]+args[0]),baseVertex:args[3]|0};
}

function waterMaterial(original,camera,isLake,pass) {
    const m=original.clone();m.targetFormat='rgba32float';m.transparent=false;m.depthWrite=false;
    const member=isLake?'@location(2) @interpolate(flat) lake: u32,':'@location(2) @interpolate(flat) river: f32,';
    if(!m.vertexShader.includes(member)||!m.fragmentShader.includes(member))throw new Error('Water varying signature changed');
    const extra=member+'\n    @location(3) contactRelative: vec3<f32>,';
    m.vertexShader=m.vertexShader.replace(member,extra).replace('o.wp = wp;',`o.wp = wp; o.contactRelative=wp-${vec(camera)};`);
    m.fragmentShader=m.fragmentShader.replace(member,extra);
    const kind=isLake?'f32(in.lake)+2.0':'-in.river-1.0';
    if(pass!=='position') {
        const op=pass==='dx'?'dpdx':'dpdy';
        m.fragmentShader=m.fragmentShader.replace(/(fn main\(in: Near(?:Water|River)VOut\) -> @location\(0\) vec4<f32> \{)/,
            `$1
    let contactB=in.pos.w;
    let contactDB=${op}(contactB);
    let contactDA=${op}(in.contactRelative*contactB);
    let contactDiff=vec4<f32>((contactDA-in.contactRelative*contactDB)/contactB,contactDB/contactB);`);
    }
    if(!m.fragmentShader.includes('    return c;'))throw new Error('Water shader output marker missing');
    m.fragmentShader=m.fragmentShader.replace('    return c;',pass==='position'?`    return vec4<f32>(in.contactRelative,${kind});`:'    return contactDiff;');
    return m;
}

export async function captureContact({retainGeometry=false,compareToRetained=false,anchorWorld=null,auditCoverage=false,auditDepth=false}={}) {
    if(auditDepth)throw new Error('Legacy depth-test audit does not measure the current shader-depth contact; use the normal contact pass');
    const started=Date.now(),g=window.gameEngine,f=g.renderer,b=f.backend,d=b.device,t=f.quadtreeTerrainRenderer,n=f.nearWaterRenderer;
    const width=b._viewport.width,height=b._viewport.height,cam=f.camera,camera=[cam.position.x,cam.position.y,cam.position.z];
    const o=g.planetConfig.origin,origin=[o.x,o.y,o.z],frame=makeFrame(sub(camera,origin),g.planetConfig.radius);
    const rt=target(d,width,height), allocations=[],materials=[],exports=[];
    const saved={target:b._currentRenderTarget,clear:b._clearColor,draw:b.draw,indirect:b.drawIndexedIndirect};
    const indirect=new Uint32Array(await readBuffer(d,t.tileManager.getIndirectArgsBuffer()));
    d.pushErrorScope('validation');
    let result;
    try {
        const fields=[];
        for(const pass of ['position','dx','dy']) {
            const normalPass=pass!=='position';
            b.setRenderTarget(rt);b.setClearColor(0,0,0,0);b.clear(true,true);
            b.drawIndexedIndirect=function(geometry,original,argsBuffer,offset,uniforms) {
                const args=indirect.subarray(offset/4,offset/4+5);if(!args[1]||!args[0])return;
                const item=terrainMaterial(b,original,geometry,args,camera,normalPass,allocations);
                materials.push(item.m);if(!normalPass)exports.push(item);
                return saved.indirect.call(b,geometry,item.m,argsBuffer,offset,uniforms);
            };
            t.render(cam,cam.matrixWorldInverse,cam.projectionMatrix);
            b.drawIndexedIndirect=saved.indirect;
            b.draw=function(geometry,original,uniforms) {
                const m=waterMaterial(original,camera,original===n._lakeMaterial,pass);materials.push(m);
                return saved.draw.call(b,geometry,m,uniforms);
            };
            n.render(cam,cam.matrixWorldInverse,cam.projectionMatrix);
            b.draw=saved.draw;b.submitCommands();fields.push(await readTexture(d,rt));
        }
        const positions=fields[0],bounds=[Infinity,Infinity,-Infinity,-Infinity];let waterPixels=0;
        const nearM=g.waterGpuData.near.fadeStartM;
        for(let i=0;i<width*height;i++) {
            const k=positions[4*i+3];if(!(k<0||k>=2))continue;
            if(Math.hypot(positions[4*i],positions[4*i+1],positions[4*i+2])>nearM+100)continue;
            waterPixels++;const p=frame.project([0,1,2].map(j=>positions[4*i+j]+camera[j]-origin[j]));
            bounds[0]=Math.min(bounds[0],p[0]-100);bounds[1]=Math.min(bounds[1],p[1]-100);bounds[2]=Math.max(bounds[2],p[0]+100);bounds[3]=Math.max(bounds[3],p[1]+100);
        }
        const ground=new GroundTriangles(frame,bounds);let exportedVertices=0,selectedTriangles=0;
        for(const source of exports) {
            const item=exportVertices(b,source,allocations);
            const data=await readBuffer(d,item.buffer),values=new Float32Array(data);
            const point=index=>[0,1,2].map(k=>values[4*index+k]-origin[k]);
            for(let instance=0;instance<item.instances;instance++)for(let i=0;i<item.indices.length;i+=3) {
                const ix=[0,1,2].map(k=>instance*item.vertices+item.indices[i+k]+item.baseVertex);
                if(ix.some(v=>values[4*v+3]!==1))throw new Error('Selected triangle has an uncaptured vertex');
                ground.add(...ix.map(point));selectedTriangles++;
            }
            exportedVertices+=item.vertices*item.instances;
        }
        result=measureContacts({positions,dxField:fields[1],dyField:fields[2],width,height,ground,camera,origin,nearM});
        result.junctions=measureWaterJunctions({positions,dxField:fields[1],dyField:fields[2],width,height,camera,origin,nearM});
        const errors=[];let missing=0;
        for(let i=0;i<width*height;i+=997) {
            if(positions[4*i+3]!==1||Math.hypot(...positions.subarray(4*i,4*i+3))>nearM)continue;
            const p=[0,1,2].map(k=>positions[4*i+k]+camera[k]-origin[k]),v=norm(p),xy=frame.project(p);
            if(xy[0]<bounds[0]||xy[1]<bounds[1]||xy[0]>bounds[2]||xy[1]>bounds[3])continue;
            const sample=ground.span(xy,xy,{normal:v,d:dot(v,p)});
            if(sample.covered)errors.push(Math.abs(sample.dropM));else missing++;
        }
        errors.sort((a,b)=>a-b);
        result.terrainCrossCheck={samples:errors.length,missing,p50M:errors[Math.floor(errors.length*.5)],p95M:errors[Math.floor(errors.length*.95)],maxM:errors.at(-1)};
        result.geometry={selectedTriangles,indexedTriangles:ground.triangles.length,exportedVertexSlots:exportedVertices,vertexBufferBytes:allocations.reduce((s,x)=>s+x.size,0),waterPixels};
        let probe=null;
        if(auditCoverage) {
            b.setRenderTarget(rt);b.setClearColor(0,0,0,0);b.clear(true,true);
            b.draw=function(geometry,original,uniforms) {
                if(original!==n._lakeMaterial)return;
                const m=original.clone();materials.push(m);m.targetFormat='rgba32float';m.transparent=false;m.depthWrite=false;
                m.fragmentShader=m.fragmentShader.slice(0,m.fragmentShader.lastIndexOf('@fragment'))+`
@fragment fn main(in:NearWaterVOut)->@location(0) vec4<f32> {
    if(in.lake!=${window.__connectedPrototype.metadata.body}u){discard;}
    return vec4<f32>(in.wp-${vec(camera)},f32(connectedCoverage(normalize(in.wp-U.origin))));
}`;
                return saved.draw.call(b,geometry,m,uniforms);
            };
            n.render(cam,cam.matrixWorldInverse,cam.projectionMatrix);b.draw=saved.draw;b.submitCommands();probe=await readTexture(d,rt);
            const w=g.waterGpuData,oldDebug=w.debugMode;
            let owners;
            try {
                w.debugMode=7;new Uint32Array(w.paramsData)[2]=7;d.queue.writeBuffer(w.paramsBuffer,0,w.paramsData);
                b.setRenderTarget(rt);b.setClearColor(0,0,0,0);b.clear(true,true);
                b.drawIndexedIndirect=function(geometry,original,argsBuffer,offset,uniforms) {
                    const args=indirect.subarray(offset/4,offset/4+5);if(!args[1]||!args[0])return;
                    const item=terrainMaterial(b,original,geometry,args,camera,true,allocations,true);materials.push(item.m);
                    return saved.indirect.call(b,geometry,item.m,argsBuffer,offset,uniforms);
                };
                t.render(cam,cam.matrixWorldInverse,cam.projectionMatrix);b.drawIndexedIndirect=saved.indirect;b.submitCommands();owners=await readTexture(d,rt);
            } finally {w.debugMode=oldDebug;new Uint32Array(w.paramsData)[2]=oldDebug;d.queue.writeBuffer(w.paramsBuffer,0,w.paramsData);}
            const rect=document.getElementById('gameCanvas').getBoundingClientRect();
            result.screenGaps=screenGapRuns({positions,probe,owners,edges:result.edges,width,height,cssWidth:rect.width,cssHeight:rect.height});
            const point=(a,i)=>[0,1,2].map(k=>a[4*i+k]+camera[k]-origin[k]);
            const debug=window.__connectedPrototype.debug,projected=debug?.triangles.map(tr=>tr.map(debug.project));
            const info=i=>{
                const p=point(probe,i),xy=frame.project(p),v=norm(p),sample=ground.span(xy,xy,{normal:v,d:dot(v,p)});
                const terrain=positions[4*i+3]===1?point(positions,i):null;
                const q=debug?.project(p),sourceTriangles=[];
                projected?.forEach((tr,id)=>{if(triangleInterval(q,q,...tr))sourceTriangles.push({id,wet:debug.topology.wet[id],
                    connected:debug.topology.connected[id],component:debug.topology.component[id],
                    componentStats:debug.topology.components.get(debug.topology.component[id])});});
                return {index:i,x:i%width,y:Math.floor(i/width),coverage:probe[4*i+3],visibleKind:positions[4*i+3],
                    sourceTriangles,
                    distanceM:Math.hypot(...sub(p,sub(camera,origin))),
                    probeGroundDropM:sample.covered?sample.dropM:null,
                    terrainInFrontByM:terrain?Math.hypot(...sub(p,sub(camera,origin)))-Math.hypot(...sub(terrain,sub(camera,origin))):null};
            };
            result.coverageAudit={edgesOver25cm:result.edges.filter(e=>e.kind==='lake'&&e.status==='hanging'&&e.minDropM>.25)
                .map(e=>({...e,neighbour:info(e.neighbourIndex)})),removedPixels:[]};
            if(!debug)result.coverageAudit.edgesHanging=result.edges.filter(e=>e.kind==='lake'&&e.status==='hanging')
                .map(e=>({...e,neighbour:info(e.neighbourIndex)}));
            if(compareToRetained){const prev=window.__waterContactSource.positions,target=window.__connectedPrototype.metadata.body+2;
                for(let i=0;i<width*height;i++)if(prev[4*i+3]===target&&positions[4*i+3]!==target) {
                    const p=point(prev,i),xy=frame.project(p),v=norm(p),sample=ground.span(xy,xy,{normal:v,d:dot(v,p)});
                    result.coverageAudit.removedPixels.push({...info(i),oldSurfaceGroundDropM:sample.covered?sample.dropM:null,
                        waterSurfaceRadialChangeM:Math.hypot(...point(probe,i))-Math.hypot(...p)});
                }
            }
        }
        if(auditDepth) {
            // Diagnose existing missing water without changing the production
            // material: first allow equal depth, then bypass depth entirely.
            const neighbours=[...new Set(result.edges.filter(e=>e.kind==='lake'&&e.status==='hanging').map(e=>e.neighbourIndex))];
            const modes={},projection=cam.projectionMatrix.elements,savedProjection=Array.from(projection);
            for(const mode of ['less-equal','always','near-x16']) {
                if(mode==='near-x16') {const near=cam.near*16,far=cam.far;
                    projection[10]=-far/(far-near);projection[14]=-far*near/(far-near);}
                b.setRenderTarget(rt);b.setClearColor(0,0,0,0);b.clear(true,true);
                b.drawIndexedIndirect=function(geometry,original,argsBuffer,offset,uniforms) {
                    const args=indirect.subarray(offset/4,offset/4+5);if(!args[1]||!args[0])return;
                    const item=terrainMaterial(b,original,geometry,args,camera,true,allocations);materials.push(item.m);
                    return saved.indirect.call(b,geometry,item.m,argsBuffer,offset,uniforms);
                };
                t.render(cam,cam.matrixWorldInverse,cam.projectionMatrix);b.drawIndexedIndirect=saved.indirect;
                b.draw=function(geometry,original,uniforms) {
                    const m=waterMaterial(original,camera,original===n._lakeMaterial,'position');materials.push(m);m.depthCompare=mode==='near-x16'?'less':mode;
                    return saved.draw.call(b,geometry,m,uniforms);
                };
                n.render(cam,cam.matrixWorldInverse,cam.projectionMatrix);b.draw=saved.draw;b.submitCommands();
                const values=await readTexture(d,rt);modes[mode]=neighbours.map(index=>({index,kind:values[4*index+3]}));
            }
            projection.set(savedProjection);
            result.depthAudit={near:cam.near,far:cam.far,neighbours:neighbours.length,modes};
        }
        if(anchorWorld) {
            const p=sub(anchorWorld,origin),xy=frame.project(p),v=norm(p);
            const sample=ground.span(xy,xy,{normal:v,d:dot(v,p)});
            result.anchorSample={waterPlanetRelative:p,...sample};
            // Exact captured surface IDs: reveal terrain-coloured water below
            // a sheet without another shader or a second geometry pass.
            const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
            const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(width,height);
            for(let i=0;i<width*height;i++) {
                const kind=positions[4*i+3],color=kind>=2?[37,177,224]:kind<0?[65,215,120]:kind===1?[151,108,69]:[30,30,36];
                pixels.data.set([...color,255],4*i);
            }
            ctx.putImageData(pixels,0,0);result.surfaceIdsPng=canvas.toDataURL('image/png').split(',')[1];
        }
        if(compareToRetained) {
            const previous=window.__waterContactSource.positions,target=window.__connectedPrototype.metadata.body+2,rises=[];
            let addedLakePixels=0,removedLakePixels=0,riverReplacedByLakePixels=0,otherLakeReplacedPixels=0,raisedRiverOver25cmPixels=0;
            for(let i=0;i<width*height;i++) {
                const before=previous[4*i+3],after=positions[4*i+3];
                if(after===target&&before!==target)addedLakePixels++;
                if(before===target&&after!==target)removedLakePixels++;
                if(before>=2&&before!==target&&after===target)otherLakeReplacedPixels++;
                if(before<0&&after===target) {
                    riverReplacedByLakePixels++;
                    const radius=a=>Math.hypot(...[0,1,2].map(k=>a[4*i+k]+camera[k]-origin[k]));
                    const rise=radius(positions)-radius(previous);rises.push(rise);if(rise>.25)raisedRiverOver25cmPixels++;
                }
            }
            rises.sort((a,b)=>a-b);
            result.coverageChange={addedLakePixels,removedLakePixels,riverReplacedByLakePixels,otherLakeReplacedPixels,raisedRiverOver25cmPixels,
                riverRiseP95M:rises[Math.floor(rises.length*.95)]??null,riverRiseMaxM:rises.at(-1)??null};
        }
        if(retainGeometry)window.__waterContactSource={ground,origin,camera,positions};
        result.elapsedMs=Date.now()-started;
    } finally {
        b.draw=saved.draw;b.drawIndexedIndirect=saved.indirect;b.submitCommands();
        await d.queue.onSubmittedWorkDone();b.setRenderTarget(saved.target);b._clearColor=saved.clear;
        rt.color.destroy();rt.depth.destroy();for(const x of allocations)x.destroy();
        for(const m of materials)b.destroyMaterial(m);
        const error=await d.popErrorScope();if(error)throw new Error(error.message);
    }
    return result;
}

// Geometry-only audit: reuse the actual selected/stiched terrain vertices,
// without invoking water materials or their read-only scene-depth pass.
export async function captureGround(boundsM=400) {
    const g=window.gameEngine,f=g.renderer,b=f.backend,d=b.device,t=f.quadtreeTerrainRenderer;
    const cam=f.camera,o=g.planetConfig.origin,origin=[o.x,o.y,o.z];
    const camera=[cam.position.x,cam.position.y,cam.position.z];
    const frame=makeFrame(sub(camera,origin),g.planetConfig.radius);
    const ground=new GroundTriangles(frame,[-boundsM,-boundsM,boundsM,boundsM]);
    const rt=target(d,32,32),allocations=[],exports=[],materials=[];
    const saved={target:b._currentRenderTarget,clear:b._clearColor,indirect:b.drawIndexedIndirect};
    const indirect=new Uint32Array(await readBuffer(d,t.tileManager.getIndirectArgsBuffer()));
    d.pushErrorScope('validation');
    try {
        b.setRenderTarget(rt);b.setClearColor(0,0,0,0);b.clear(true,true);
        b.drawIndexedIndirect=function(geometry,original,argsBuffer,offset,uniforms){
            const args=Array.from(indirect.subarray(offset/4,offset/4+5));
            if(!args[0]||!args[1])return;
            exports.push({geometry,original,args});
            const {m}=terrainMaterial(b,original,geometry,args,camera,false,allocations);materials.push(m);
            return saved.indirect.call(b,geometry,m,argsBuffer,offset,uniforms);
        };
        t.render(cam,cam.matrixWorldInverse,cam.projectionMatrix);
        b.drawIndexedIndirect=saved.indirect;b.submitCommands();
        for(const source of exports){
            const item=exportVertices(b,source,allocations),values=new Float32Array(await readBuffer(d,item.buffer));
            const point=index=>[0,1,2].map(k=>values[4*index+k]-origin[k]);
            for(let instance=0;instance<item.instances;instance++)for(let i=0;i<item.indices.length;i+=3){
                const ix=[0,1,2].map(k=>instance*item.vertices+item.indices[i+k]+item.baseVertex);
                ground.add(...ix.map(point));
            }
        }
    } finally {
        b.drawIndexedIndirect=saved.indirect;b.setRenderTarget(saved.target);
        b._clearColor=saved.clear;rt.color.destroy();rt.depth.destroy();
        for(const m of materials)b.destroyMaterial(m);
        for(const a of allocations)a.destroy();
    }
    const error=await d.popErrorScope();if(error)throw new Error(error.message);
    return ground;
}
