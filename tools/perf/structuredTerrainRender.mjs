// Offscreen geometry inspection on Dawn; production terrain, lake and river
// surface shaders. Plain terrain colour isolates the shape from textures.
/* global process */
import fs from 'node:fs';
import { setupLab } from '../../../terrain-lab/labsetup.mjs';
import { writePNG, montage } from '../../../terrain-lab/png.mjs';
const root=process.argv[2], rid=Number(process.argv[3]??17);
const {device,gen,imp,planetConfig}=await setupLab(root);
device.addEventListener('uncapturederror',e=>{throw new Error(e.error.message);});
const {WaterService}=await imp('core/world/hydrology/WaterService.js');
const {WaterGpuData}=await imp('core/world/water/WaterGpuData.js');
const {buildRiverRibbons}=await imp('core/world/water/riverRibbon.js');
const {tangentBasis,planeToDir}=await imp('core/world/hydrology/lakeRefine.js');
const sh=await imp('core/renderer/water/nearWaterSurface.wgsl.js');
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const output='tools/perf/structured-terrain-results'; fs.mkdirSync(output,{recursive:true});
const cells=Number(process.env.LAB_RENDER_CELLS??128);
const R=planetConfig.radius;
const svc=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false,config:{cache:false,landscape:JSON.parse(process.env.LAB_LANDSCAPE??'{}')}});
const gpu=new WaterGpuData(device,{gridN:512,planetRadius:R,carve:svc.config.carve,valley:svc.config.valley});
gen.setWaterCarveResources(gpu.resources);svc.setWaterCarveResources(gpu.resources);
gen.setRiverValleyResources(gpu.valleyResources);svc.setRiverValleyResources(gpu.valleyResources);
await svc.start(); const rec=await svc.refineRiver(rid), P=rec.points, st=rec.stride;

const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0), cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{const l=Math.hypot(...a);return a.map(v=>v/l)};
function view(eye,target,up){const z=norm(eye.map((v,i)=>v-target[i])),x=norm(cross(up,z)),y=cross(z,x);return [x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]}
function projection(aspect){const f=1/Math.tan(.65/2),n=1,far=100000;return [f/aspect,0,0,0,0,f,0,0,0,0,far/(n-far),-1,0,0,n*far/(n-far),0]}
const W=1100,H=760;
const uniform=device.createBuffer({size:sh.NEAR_WATER_UNIFORM_FLOATS*4,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
const sampler=device.createSampler({magFilter:'linear',minFilter:'linear'});
const trans=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
device.queue.writeTexture({texture:trans},new Uint8Array([255,255,255,255]),{},[1,1]);
const VF=GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT;
const layouts=[device.createBindGroupLayout({entries:[{binding:0,visibility:VF,buffer:{type:'uniform'}}]}),device.createBindGroupLayout({entries:[
 {binding:12,visibility:VF,buffer:{type:'read-only-storage'}},{binding:13,visibility:VF,buffer:{type:'read-only-storage'}},
 {binding:14,visibility:VF,texture:{sampleType:'float',viewDimension:'2d-array'}},{binding:15,visibility:VF,buffer:{type:'uniform'}},
 {binding:16,visibility:VF,buffer:{type:'read-only-storage'}},{binding:17,visibility:VF,sampler:{type:'filtering'}},
 {binding:18,visibility:VF,texture:{sampleType:'float',viewDimension:'2d'}}]}),
 device.createBindGroupLayout({entries:[{binding:0,visibility:VF,buffer:{type:'read-only-storage'}},{binding:1,visibility:VF,buffer:{type:'read-only-storage'}}]})];
const layout=device.createPipelineLayout({bindGroupLayouts:layouts});
const prefix=sh.buildNearRiverVertexShader().split('@vertex')[0];
const terrainCode=prefix+`
struct TerrainOut{@builtin(position) pos:vec4<f32>,@location(0) wp:vec3<f32>,@location(1) normal:vec3<f32>};
@vertex fn terrainV(@location(0) p:vec3<f32>,@location(1) n:vec3<f32>)->TerrainOut{var o:TerrainOut;o.pos=U.projectionMatrix*U.viewMatrix*vec4<f32>(p,1.0);o.wp=p;o.normal=n;return o;}
@fragment fn terrainF(in:TerrainOut)->@location(0) vec4<f32>{let up=normalize(in.wp);let L=normalize(U.sunDir);let light=U.ambientColor*U.ambientIntensity+U.sunColor*U.sunIntensity*max(dot(normalize(in.normal),L),0.0);var bed=vec3<f32>(.18,.28,.12)*light;let river=waterRiverAt(up,length(in.wp)-U.R);if(river.near){bed=vec3<f32>(.26,.21,.15)*light;}return vec4<f32>(${process.env.LAB_PLAIN_TERRAIN?'bed':'applyWater(bed,in.wp,U.cameraPos,U.origin,L,U.sunColor*U.sunIntensity,U.ambientColor*U.ambientIntensity,nearWaterSampler)'},1.0);}`;
const terrainModule=device.createShaderModule({code:terrainCode});
for(const msg of (await terrainModule.getCompilationInfo()).messages) if(msg.type==='error') throw Error(msg.message);
const common={layout,primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'less-equal',depthWriteEnabled:true},multisample:{count:1}};
const terrainPipeline=device.createRenderPipeline({...common,vertex:{module:terrainModule,entryPoint:'terrainV',buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]}]},fragment:{module:terrainModule,entryPoint:'terrainF',targets:[{format:'rgba8unorm'}]}});
const blend={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}};
function surfacePipeline(v,f){if(process.env.LAB_SOLID_WATER)f=f.replace('let c = nearWaterShade(in.wp, lake.level);','let c = vec4<f32>(0.1,0.5,0.9,1.0);').replace('let c = nearWaterShade(wp, hit.etaM);','let c = vec4<f32>(0.1,0.5,0.9,1.0);');return device.createRenderPipeline({...common,depthStencil:{...common.depthStencil,depthWriteEnabled:false},vertex:{module:device.createShaderModule({code:v}),entryPoint:'main'},fragment:{module:device.createShaderModule({code:f}),entryPoint:'main',targets:[{format:'rgba8unorm',blend}]}})}
const riverPipeline=surfacePipeline(sh.buildNearRiverVertexShader(),sh.buildNearRiverFragmentShader());
const lakePipeline=surfacePipeline(sh.buildNearWaterVertexShader(),sh.buildNearWaterFragmentShader());
const b0=device.createBindGroup({layout:layouts[0],entries:[{binding:0,resource:{buffer:uniform}}]});
const res=gpu.resources;
const b1=device.createBindGroup({layout:layouts[1],entries:[{binding:12,resource:{buffer:res.index}},{binding:13,resource:{buffer:res.lakes}},{binding:14,resource:res.masks},{binding:15,resource:{buffer:res.params}},{binding:16,resource:{buffer:res.rivers}},{binding:17,resource:sampler},{binding:18,resource:trans.createView()}]});
const buf=(a,usage)=>{const b=device.createBuffer({size:Math.max(16,a.byteLength),usage:usage|GPUBufferUsage.COPY_DST});if(a.byteLength)device.queue.writeBuffer(b,0,a);return b};
let exit=0;while(exit+1<P.length/st&&P[(exit+1)*st+9]<0)exit++;
const hillPoint=Math.min(Math.floor(P.length/st*.5),P.length/st-2);
const baselineSampler=svc._sampler;
const shared=await gen.prepareRegionalTerrain({cells,seamCells:4});
const prototypeSampler=await createHydrologySampler({device,terrainGenerator:gen});
await prototypeSampler.setWaterCarveResources(gpu.resources);
await prototypeSampler.setRiverValleyResources(gpu.valleyResources);
const comparisons=[];
const survey=JSON.parse(fs.readFileSync(`${output}/benchmark-256.json`));
const landmarks=[survey.bounds.highestBound.direction,survey.error.worstDirection];
for(const [label,k,size,step] of [['outlet',exit,850,1.5],['banks',Math.min(280,P.length/st-2),1200,2],['descent',hillPoint,2400,4],['aerial',exit,8000,16],['highland',-1,24000,48],['erosion',-2,8000,16]]){ 
 const c=k<0?norm(landmarks[-k-1]):norm(Array.from(P.subarray(k*st,k*st+3))),{e1,e2}=tangentBasis(c);
 const level=k<0?(await baselineSampler.samplePatch({c,e1,e2,x0:-1,y0:-1,spacing:2,nx:1,ny:1},R))[0]:P[k*st+16];
 const n=Math.ceil(size/step),frame={c,e1,e2,x0:-size/2,y0:-size/2,spacing:step,nx:n,ny:n};
 const target=c.map(v=>v*(R+level)),eye=target.map((v,i)=>v+e1[i]*size*.22-e2[i]*size*.63+c[i]*size*.34);
 const cam={x:eye[0],y:eye[1],z:eye[2]};gpu.update(svc,cam,0);
 const images=[],grids=[];
 for(const mode of ['baseline','prototype']){
 gen.regionalTerrainActive=mode==='prototype';
 const heights=await (mode==='prototype'?prototypeSampler:baselineSampler).samplePatch(frame,R,{carved:true});grids.push(heights);
 const verts=new Float32Array(n*n*6);
 for(let j=0;j<n;j++)for(let i=0;i<n;i++){const k=j*n+i,d=planeToDir(frame.x0+(i+.5)*step,frame.y0+(j+.5)*step,frame,R);const hx=(heights[j*n+Math.min(n-1,i+1)]-heights[j*n+Math.max(0,i-1)])/(2*step),hy=(heights[Math.min(n-1,j+1)*n+i]-heights[Math.max(0,j-1)*n+i])/(2*step);const no=norm(d.map((v,a)=>v-e1[a]*hx-e2[a]*hy));verts.set([...d.map(v=>v*(R+heights[k])),...no],k*6);}
 const indices=new Uint32Array((n-1)*(n-1)*6);let at=0;for(let j=0;j<n-1;j++)for(let i=0;i<n-1;i++){const k=j*n+i;indices.set([k,k+n,k+1,k+1,k+n,k+n+1],at);at+=6;}
 const vb=buf(verts,GPUBufferUsage.VERTEX),ib=buf(indices,GPUBufferUsage.INDEX);
 if(process.env.LAB_DEBUG_GEOMETRY && label==='outlet'){
 const data=new Float32Array(n*n*4);for(let k=0;k<n*n;k++)data.set([verts[k*6],verts[k*6+1],verts[k*6+2],0],k*4);
 const db=buf(data,GPUBufferUsage.STORAGE),ob=device.createBuffer({size:n*n*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),rb2=device.createBuffer({size:n*n*32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const code=prefix+`@group(2) @binding(0) var<storage,read> ip:array<vec4<f32>>;@group(2) @binding(1) var<storage,read_write> op:array<vec4<f32>>;@compute @workgroup_size(64) fn dbg(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=arrayLength(&ip)){return;}let d=normalize(ip[i].xyz);let h=length(ip[i].xyz)-waterParams.planetRadius;let r=waterRiverAt(d,h);let l=waterLakeLevelView(d,h,nearWaterSampler,false);op[2u*i]=vec4<f32>(r.etaM,l,r.sM,r.pool);op[2u*i+1u]=vec4<f32>(r.distM,r.halfWidthM,r.depthM,select(0.0,1.0,r.near));}`;
 const cp=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'dbg'}}),bg1=device.createBindGroup({layout:cp.getBindGroupLayout(1),entries:[{binding:12,resource:{buffer:res.index}},{binding:13,resource:{buffer:res.lakes}},{binding:14,resource:res.masks},{binding:15,resource:{buffer:res.params}},{binding:16,resource:{buffer:res.rivers}},{binding:17,resource:sampler}]}),bg2=device.createBindGroup({layout:cp.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:db}},{binding:1,resource:{buffer:ob}}]});
 const ec=device.createCommandEncoder(),pp=ec.beginComputePass();pp.setPipeline(cp);pp.setBindGroup(1,bg1);pp.setBindGroup(2,bg2);pp.dispatchWorkgroups(Math.ceil(n*n/64));pp.end();ec.copyBufferToBuffer(ob,0,rb2,0,n*n*32);device.queue.submit([ec.finish()]);await rb2.mapAsync(GPUMapMode.READ);const out=new Float32Array(rb2.getMappedRange());
 const vm=view(eye,target,c),pm=projection(W/H),mul=(m,p)=>[0,1,2,3].map(i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12]*p[3]);
 for(const pix of[[940,365],[947,392],[957,407],[1000,350],[940,349]]){let best=Infinity,bk=0;for(let k=0;k<n*n;k++){const z=mul(pm,mul(vm,[...data.subarray(k*4,k*4+3),1])),x=(z[0]/z[3]+1)*W/2,y=(1-z[1]/z[3])*H/2,dd=Math.hypot(x-pix[0],y-pix[1]);if(dd<best){best=dd;bk=k}}console.log('pixel',pix,'gap',best.toFixed(1),'ground',Math.hypot(...data.subarray(bk*4,bk*4+3))-R,'river eta / lake / arc / pool / dist / hw / depth / near',Array.from(out.subarray(bk*8,bk*8+8)));}
 rb2.unmap();db.destroy();ob.destroy();rb2.destroy();
 }
 const ribbon=buildRiverRibbons({rivers:[[rid,rec]],arcOf:r=>gpu._arcLengths(r),camera:cam,rangeM:Math.max(2500,size*2),R,origin:{x:0,y:0,z:0},shape:svc.config.carve,lakeAt:d=>gpu.lakeAt(d)});
 const pb=buf(ribbon.points,GPUBufferUsage.STORAGE),qb=buf(ribbon.quads,GPUBufferUsage.STORAGE),b2=device.createBindGroup({layout:layouts[2],entries:[{binding:0,resource:{buffer:pb}},{binding:1,resource:{buffer:qb}}]});
 const U=new Float32Array(sh.NEAR_WATER_UNIFORM_FLOATS);U.set(view(eye,target,c),0);U.set(projection(W/H),16);U[35]=R;U.set(eye,36);U[39]=Math.max(2000,size*2);U[40]=96;U[41]=0;
 const lakes=gpu.lakesNear(cam,Math.max(2500,size*2));U.set(lakes,44);const L=norm(c.map((v,i)=>v*.85+e1[i]*.2-e2[i]*.3));U.set([...L,1.0],60);U.set([1,.96,.88,.5],64);U.set([.45,.55,.7,R],68);U.set([.32,.43,.52,0],80);
 device.queue.writeBuffer(uniform,0,U);
 const lakeN=96,lakeIdx=new Uint32Array((lakeN-1)*(lakeN-1)*6);at=0;for(let j=0;j<lakeN-1;j++)for(let i=0;i<lakeN-1;i++){const k=j*lakeN+i;lakeIdx.set([k,k+lakeN,k+1,k+1,k+lakeN,k+lakeN+1],at);at+=6;}const lib=buf(lakeIdx,GPUBufferUsage.INDEX);
 const colour=device.createTexture({size:[W,H],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),depth=device.createTexture({size:[W,H],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});
 const row=Math.ceil(W*4/256)*256,rb=device.createBuffer({size:row*H,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const enc=device.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[{view:colour.createView(),clearValue:{r:.45,g:.6,b:.72,a:1},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
 pass.setBindGroup(0,b0);pass.setBindGroup(1,b1);pass.setBindGroup(2,b2);pass.setPipeline(terrainPipeline);pass.setVertexBuffer(0,vb);pass.setIndexBuffer(ib,'uint32');pass.drawIndexed(indices.length);
 if(lakes.length && !process.env.LAB_HIDE_LAKE){pass.setPipeline(lakePipeline);pass.setIndexBuffer(lib,'uint32');pass.drawIndexed(lakeIdx.length,lakes.length);}
 if(!process.env.LAB_HIDE_RIVER && ribbon.quads.length){pass.setPipeline(riverPipeline);pass.draw(ribbon.quads.length*6);}pass.end();enc.copyTextureToBuffer({texture:colour},{buffer:rb,bytesPerRow:row},[W,H]);device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);const a=new Uint8Array(rb.getMappedRange()),rgb=new Uint8Array(W*H*3);for(let j=0;j<H;j++)for(let i=0;i<W;i++)for(let q=0;q<3;q++)rgb[(j*W+i)*3+q]=Math.round(255*Math.pow(a[j*row+i*4+q]/255,1/2.2));
 images.push(rgb);
 writePNG(`${output}/river-${rid}-${label}-${mode}-${cells}.png`,W,H,rgb);
 console.log(`rendered ${label} ${mode}: point ${k}, ${size}m, ${lakes.length} lakes, ${ribbon.quads.length} river quads`);
 rb.unmap();for(const x of [vb,ib,pb,qb,lib,rb,colour,depth])x.destroy();
 }
 const pair=montage(images,W,H);writePNG(`${output}/river-${rid}-${label}-comparison-${cells}.png`,pair.w,pair.h,pair.rgb);
 let sum=0,max=0;for(let i=0;i<grids[0].length;i++){const d=Math.abs(grids[1][i]-grids[0][i]);sum+=d;max=Math.max(max,d);}
 comparisons.push({label,point:k,frame,metres:size,samples:n*n,meanAbsoluteHeightDifferenceM:sum/grids[0].length,maxHeightDifferenceM:max});

}
fs.writeFileSync(`${output}/river-${rid}-visual-${cells}.json`,JSON.stringify({river:rid,cells,seed:gen.seed,radius:R,representation:'Production carved terrain and production lake/river surfaces; diagnostic plain terrain material; tile micro omitted by hydrology sampler',left:'baseline',right:'prototype',shared:shared.timings,comparisons},null,2));
process.exit(0);
