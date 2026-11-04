import { AnthillViewModule } from './AnthillViewModule.js';
import { Geometry, Material } from '../renderer/resources/index.js';
import { composeClipFromLocal } from './cameraRelative.js';
import { noiseWGSL } from './noise.js';
import { rockStructsWGSL, rockFunctionsWGSL } from './rockShader.wgsl.js';
import { volumeDeclarationsWGSL, volumeFunctionsWGSL } from './volumeShader.wgsl.js';
import { viewStruct, volumeBoundsDeclarationsWGSL, volumeTraversalWGSL } from './volumeTraversal.wgsl.js';
import { AnthillLighting } from './AnthillLighting.js';
import { lightingDeclarationsWGSL, lightingFunctionsWGSL } from './lighting.wgsl.js';
import { SparseVolumeNormalsGPU, normalDeclarationsWGSL, normalFunctionsWGSL } from './SparseVolumeNormalsGPU.js';
import { VolumeMeshCache } from './VolumeMeshCache.js';
import { meshVertexWGSL, meshFragmentWGSL, meshTraceDeclarationsWGSL } from './meshShader.wgsl.js';

const declarations = `${viewStruct}
${rockStructsWGSL}
@group(0) @binding(1) var<uniform> rock: Rock;
@group(0) @binding(2) var heights: texture_2d<f32>;
${volumeDeclarationsWGSL}
${volumeBoundsDeclarationsWGSL}
${lightingDeclarationsWGSL}
${normalDeclarationsWGSL}
struct VertexInput { @location(0) position: vec3<f32> }
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) screen: vec2<f32> }
`;
const vertexShader = `${declarations}
@vertex fn main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = vec4<f32>(input.position, 1.0);
    out.screen = input.position.xy;
    return out;
}`;
const traceWGSL = (meshes=false) => /* wgsl */ `
fn traceRay(screen: vec2<f32>) -> vec4<f32> {
    let offset = screen.x * view.right.xyz * view.right.w + screen.y * view.up.xyz * view.up.w;
    let perspective = view.eye.w > 0.0;
    var origin = view.eye.xyz + offset;
    var direction = view.direction.xyz;
    var near = 0.0;
    var far = view.direction.w;
    if (perspective) {
        origin = view.eye.xyz;
        direction = normalize(view.direction.xyz + offset);
        let forward = dot(direction, view.direction.xyz);
        near = view.eye.w / forward;
        far /= forward;
    }
    let boundsMin = volume.origin.xyz;
    let boundsMax = boundsMin + vec3<f32>(volume.counts.xyz - vec3<u32>(1u)) * volume.origin.w;
    // Explicit parallel-ray slabs avoid 0 * infinity at axis-aligned turns.
    for (var axis = 0u; axis < 3u; axis++) {
        if (abs(direction[axis]) < 0.0000001) {
            if (origin[axis] < boundsMin[axis] || origin[axis] > boundsMax[axis]) { return vec4<f32>(0,0,0,-1); }
        } else {
            let a = (boundsMin[axis] - origin[axis]) / direction[axis];
            let b = (boundsMax[axis] - origin[axis]) / direction[axis];
            near = max(near, min(a,b));
            far = min(far, max(a,b));
        }
    }
    var cutEntry = false;
    if (view.params.y > 0.5) {
        let distance = dot(origin, view.plane.xyz) - view.plane.w;
        let rate = dot(direction, view.plane.xyz);
        if (abs(rate) < 0.0000001) {
            if (distance > 0.0) { return vec4<f32>(0,0,0,-1); }
        } else {
            let crossing = -distance / rate;
            if (rate < 0.0) {
                cutEntry = crossing >= near;
                near = max(near, crossing);
            } else { far = min(far, crossing); }
        }
    }
    if (far < near) { return vec4<f32>(0,0,0,-1); }
    // Preserve the anthill's limited tunnel visibility; external inspection can see the whole region.
    if (view.params.z < 0.5) { far = min(far, near + volume.normalDepth.w); }
    let entry=origin+direction*near;
    if(volumeDensity(entry)>0.0) { return vec4<f32>(entry,select(1.0,0.0,cutEntry)); }
    if(far<=near) { return vec4<f32>(0,0,0,-1); }
    ${meshes ? `
    let pixel=vec2<u32>(clamp((vec2<f32>(screen.x,-screen.y)+vec2<f32>(1))*0.5*vec2<f32>(textureDimensions(meshHits)),
        vec2<f32>(0),vec2<f32>(textureDimensions(meshHits)-vec2<u32>(1))));
    let rasterHit=textureLoad(meshHits,vec2<i32>(pixel),0);
    let meshHit=vec4<f32>(rasterHit.xyz,1.0);
    let meshDistance=dot(meshHit.xyz-origin,direction);
    let validMesh=rasterHit.w>0.0 && meshDistance>=near && meshDistance<=far;
    // A complete patch supplies its nearest rasterized surface. Only bypass
    // density inside that patch; all preceding, possibly dirty patches still
    // use the original traversal. No per-probe mesh-grid lookup is needed.
    if(validMesh) { far=min(far,max(near,meshDistance-(rasterHit.w-1.0))); }
    ` : ''}
    let stride = max(max(volume.origin.w * 0.5, view.params.x * 0.5), (far-near) / 8191.0);
    var low = near;
    var high = near;
    var found = false;
    var probe = 1u;
    var checkAfter = near;
    var coarseCheckAfter = near;
    var baselineUntil = near;
    for (var step = 0u; step < 8192u; step++) {
        high = min(near + f32(probe) * stride, far);
        if (volumeDensity(origin + direction * high) > 0.0) { found = true; break; }
        if (high >= far) { break; }
        if (view.params.w > 0.5) {
            var skip = 0.0;
            if(high >= coarseCheckAfter) {
                let block = blockBounds(origin+direction*high,direction,false);
                coarseCheckAfter=high+block.x;
                baselineUntil=high;
                if(block.z<0.5) { baselineUntil=coarseCheckAfter; }
                if(block.y<=0.0){skip=block.x;}
            }
            if(high<baselineUntil) {
                skip=max(skip,min(baselineUntil-high,baselineAirStep(origin+direction*high,direction)));
            }
            if(skip<=stride && high>=checkAfter && view.cutOrigin.x<f32(volume.counts.w)) {
                let block=blockBounds(origin+direction*high,direction,true);
                checkAfter=high+block.x;
                if(block.y<=0.0){skip=block.x;}
            }
            if(skip>stride) {
                // Stay on the reference probe lattice: do not trade detail for speed.
                probe=max(probe+1u,u32(ceil((min(high+skip,far)-near)/stride)));
                low=max(near,near+f32(probe-1u)*stride);
                continue;
            }
        }
        low = high;
        probe++;
    }
    if (!found) { ${meshes ? `if(validMesh) { return meshHit; }` : ''} return vec4<f32>(0,0,0,-1); }
    let face = cutEntry && high == near;
    if (high > near) {
        for (var refine = 0u; refine < 8u; refine++) {
            if(high-low <= view.params.x*0.05) { break; }
            let middle = (low + high) * 0.5;
            if (volumeDensity(origin + direction * middle) > 0.0) { high = middle; }
            else { low = middle; }
        }
    }
    let point = origin + direction * high;
    // Preserve the physical hit and distinguish artificial cut faces from real surfaces.
    return vec4<f32>(point, select(1.0, 0.0, face));
}
`;
const shadeWGSL = /* wgsl */ `
struct HitOutput { @location(0) color: vec4<f32>, @builtin(frag_depth) depth: f32 }
fn shadeHit(hit: vec4<f32>) -> HitOutput {
    let clip=view.clipFromLocal*vec4<f32>(hit.xyz,1);
    var out: HitOutput;
    let footprint = view.params.x * select(1.0, length(hit.xyz - view.eye.xyz), view.eye.w > 0.0);
    let albedo = rockColor(hit.xyz,footprint);
    var radiance = albedo * 0.20; // Readable section material; the cut does not expose rock to light.
    if (hit.w > 0.5) {
        let gradient = volumeGradient(hit.xyz);
        var geometricNormal = -gradient / max(length(gradient), 0.00001);
        if (length(gradient) < 0.00001) { geometricNormal = -view.direction.xyz; }
        var normal = volumeShadingNormal(hit.xyz);
        if (dot(normal, geometricNormal) < 0.1) { normal = geometricNormal; }
        radiance = albedo * anthillSurfaceIrradiance(hit.xyz, normal, geometricNormal, true);
    }
    out.color=vec4<f32>(displayRadiance(radiance),1);
    out.depth=clamp(clip.z/clip.w,0.0,1.0);
    return out;
}
`;
// Keep a reference fragment path for image and performance comparisons.
const fragmentShader = `${declarations}
${noiseWGSL}
${rockFunctionsWGSL}
${volumeFunctionsWGSL}
${volumeTraversalWGSL}
${traceWGSL()}
${lightingFunctionsWGSL}
${normalFunctionsWGSL}
${shadeWGSL}
@fragment fn main(input: VertexOutput) -> HitOutput {
    let hit=traceRay(input.screen);
    if(hit.w<0.0) { discard; }
    return shadeHit(hit);
}`;
const computeShader = (meshes=false) => `${viewStruct}
${volumeDeclarationsWGSL}
@group(0) @binding(8) var<storage,read> chunkMaxima: array<f32>;
@group(0) @binding(9) var<storage,read> coarseMaxima: array<f32>;
@group(0) @binding(3) var hitOutput: texture_storage_2d<rgba32float,write>;
${volumeFunctionsWGSL.split('// A bounded search')[0]}
${volumeTraversalWGSL}
${meshes?meshTraceDeclarationsWGSL:''}
${traceWGSL(meshes)}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size=textureDimensions(hitOutput);
    if(any(id.xy>=size)) { return; }
    let screen=(vec2<f32>(id.xy)+vec2<f32>(0.5))/vec2<f32>(size)*2.0-vec2<f32>(1);
    let hit=traceRay(vec2<f32>(screen.x,-screen.y));
    textureStore(hitOutput,vec2<i32>(id.xy),hit);
}`;
const shadeFragmentShader = `${declarations}
@group(0) @binding(3) var hits: texture_2d<f32>;
${volumeFunctionsWGSL.split('// A bounded search')[0]}
${volumeTraversalWGSL}
${noiseWGSL}
${rockFunctionsWGSL}
${lightingFunctionsWGSL}
${normalFunctionsWGSL}
${shadeWGSL}
@fragment fn main(input: VertexOutput) -> HitOutput {
    let hit=textureLoad(hits,vec2<i32>(input.position.xy),0);
    if(hit.w<0.0) { discard; }
    return shadeHit(hit);
}`;

/** Orthographic or perspective camera-ray rendering over the same sparse 3D field as the slice view.
 * Inspection flags are view policy; no camera controls or DOM dependencies live here.
 * Traces into a hit texture in compute, then shades it in the opaque pass with hit depth.
 * `useCompute = false` retains the reference fragment path for comparisons.
 * At overview scale sampling follows pixel footprint; zoom in for sub-voxel features.
 */
export class VolumeViewModule extends AnthillViewModule {
    constructor(options) {
        super(options);
        this.lighting = options.lighting ?? new AnthillLighting();
        this.normalCacheMaxBytes = options.normalCacheMaxBytes ?? 64*1024*1024;
        this.rayData = new Float32Array(48);
        this.inspection = false;
        this.emptySpaceSkipping = true;
        this.useCompute = true;
        this.reuseHits = true;
        this.clipEnabled = true;
        this.showGround = true;
        this.meshLOD = options.meshLOD ?? true;
        this.meshOptions = options.meshOptions ?? {};
    }

    initialize(context) {
        super.initialize(context);
        this.normalGPU = new SparseVolumeNormalsGPU(this.volumeGPU,{maxBytes:this.normalCacheMaxBytes});
        this.rayGeometry = new Geometry()
            .setAttribute('position', new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]), 3)
            .setIndex(new Uint32Array([0,1,2,0,2,3]));
        const entries = this.faceMaterial.bindGroupLayoutSpec[0].entries.filter(entry => entry.binding !== 3);
        entries.push({ binding: 8, name: 'chunkMaxima', visibility: 'fragment', buffer: { type: 'read-only-storage' } });
        entries.push({ binding: 9, name: 'coarseMaxima', visibility: 'fragment', buffer: { type: 'read-only-storage' } });
        entries.push({ binding: 10, name: 'lighting', visibility: 'fragment', buffer: { type: 'uniform' } });
        entries.push({ binding: 12, name: 'shadingNormals', visibility: 'fragment', buffer: { type: 'read-only-storage' } });
        entries.push({ binding: 14, name: 'normalSlots', visibility: 'fragment', buffer: { type: 'read-only-storage' } });
        this.rayMaterial = new Material({
            name: 'Voxel camera rays', vertexShader, fragmentShader, side: 'double',
            uniforms: { view: { value: this.rayData }, rock: { value: this.rockData },
                heights: { value: this.heightTexture }, volume: { value: this.volumeData },
                lighting: { value: this.lighting.data } },
            storageBuffers: { ...this.faceMaterial.storageBuffers, chunkMaxima: this.volumeGPU.chunkMaxima, coarseMaxima: this.volumeGPU.coarseBounds,
                shadingNormals:this.normalGPU.buffer,normalSlots:this.normalGPU.mapBuffer },
            bindGroupLayoutSpec: [{ entries }],
        });
        const device=this.backend.device;
        this.traceViewBuffer=device.createBuffer({label:'Voxel ray view',size:this.rayData.byteLength,usage:64|8});
        this.traceVolumeBuffer=device.createBuffer({label:'Voxel ray volume',size:64,usage:64|8});
        this.meshCache=new VolumeMeshCache(this.region.volume,device,this.meshOptions);
        if(device.createRenderPipeline) this.meshPipeline=device.createRenderPipeline({
            label:'Voxel remodeled geometry',layout:'auto',
            vertex:{module:device.createShaderModule({code:meshVertexWGSL}),entryPoint:'main',buffers:[{
                arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]}]},
            fragment:{module:device.createShaderModule({code:meshFragmentWGSL}),entryPoint:'main',targets:[{format:'rgba32float'}]},
            primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less-equal'},
        });
        this.tracePipeline=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:computeShader()}),entryPoint:'main'}});
        this.meshTracePipeline=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:computeShader(true)}),entryPoint:'main'}});
        this.shadeMaterial=new Material({
            name:'Voxel hit shading',vertexShader,fragmentShader:shadeFragmentShader,side:'double',
            uniforms:{...this.rayMaterial.uniforms,hits:{value:null}},
            storageBuffers: {...this.rayMaterial.storageBuffers},
            bindGroupLayoutSpec:[{entries:[...entries,
                {binding:3,name:'hits',visibility:'fragment',texture:{sampleType:'unfilterable-float'}}]}],
        });
    }

    update({ camera, viewport, deltaTime = 0, time = 0 }) {
        this.lighting.update({ deltaTime, time });
        const p = camera.projectionMatrix.elements;
        const perspective = p[15] === 0 && p[11] === -1;
        if (!perspective && (p[15] !== 1 || p[11] !== 0))
            throw new Error('VolumeViewModule requires an orthographic or perspective camera');
        this._perspective = perspective;
        const local = this.frame.worldToLocal(camera.position.x,camera.position.y,camera.position.z);
        this.volumeGPU.sync();
        const focus = perspective ? local : camera.target ?? {
            x:this.plane.x(camera.center?.s??0),y:camera.center?.y??0,z:this.plane.z(camera.center?.s??0),
        };
        this.normalGPU.sync(focus);
        this.rayMaterial.storageBuffers.shadingNormals = this.normalGPU.buffer;
        this.shadeMaterial.storageBuffers.shadingNormals = this.normalGPU.buffer;
        this.rayMaterial.storageBuffers.normalSlots = this.normalGPU.mapBuffer;
        this.shadeMaterial.storageBuffers.normalSlots = this.normalGPU.mapBuffer;
        if(!this.hitTexture || this.hitWidth!==viewport.width || this.hitHeight!==viewport.height) {
            this.hitTexture?.destroy();
            this.hitWidth=viewport.width;this.hitHeight=viewport.height;
            this.hitTexture=this.backend.device.createTexture({label:'Voxel hits',size:[viewport.width,viewport.height],format:'rgba32float',usage:1|4|8});
            this.meshHitTexture?.destroy();this.meshDepthTexture?.destroy();
            this.meshHitTexture=this.backend.device.createTexture({label:'Voxel mesh hits',size:[viewport.width,viewport.height],format:'rgba32float',usage:4|16});
            this.meshDepthTexture=this.backend.device.createTexture({label:'Voxel mesh depth',size:[viewport.width,viewport.height],format:'depth32float',usage:16});
            this.meshHitView=this.meshHitTexture.createView();this.meshDepthView=this.meshDepthTexture.createView();
            this.hitView=this.hitTexture.createView();
            this.shadeMaterial.uniforms.hits.value=this.hitView;
            this.traceBindGroup=null;
            this._hitRevision = -1;
        }
        this.rayMaterial.storageBuffers.densities = this.volumeGPU.density;
        this.shadeMaterial.storageBuffers.densities = this.volumeGPU.density;
        this.volumeData.set([this.plane.normalX,0,this.plane.normalZ,this.visibilityDepth],12);
        const mpp = 2 / (p[5] * viewport.height);
        const v = camera.matrixWorldInverse.elements;
        const toLocal = vector => [this.frame.axisX,this.frame.axisY,this.frame.axisZ]
            .map(a => a.x*vector[0]+a.y*vector[1]+a.z*vector[2]);
        const right = toLocal([v[0],v[4],v[8]]), up = toLocal([v[1],v[5],v[9]]);
        const direction = toLocal([-v[2],-v[6],-v[10]]);
        composeClipFromLocal(this.frame,camera,this._clipFromLocal);
        this.rayData.set(this._clipFromLocal.elements);
        this.rayData.set([mpp,Number(this.clipEnabled),Number(this.inspection || perspective),Number(this.emptySpaceSkipping)],16);
        this.rayData.set([this.volumeGPU.boundsSize,this.volumeGPU.boundsX,this.volumeGPU.boundsY,this.volumeGPU.boundsZ],20);
        this.rayData[24]=this.volumeGPU.surfaceSlopeX;
        this.rayData[25]=this.volumeGPU.surfaceSlopeZ;
        this.rayData[26] = this.region.volume.densityRange;
        this.rayData[27] = Number(!this.region.volume.hasAdditions);
        // eye.w is zero for parallel rays and the near plane for perspective rays.
        const near = perspective ? p[14] / p[10] : 0;
        const far = perspective ? p[14] / (p[10] + 1) : -1 / p[10];
        this.rayData.set([local.x,local.y,local.z,near],28);
        this.rayData.set([...right,1/p[0]],32);
        this.rayData.set([...up,1/p[5]],36);
        this.rayData.set([...direction,far],40);
        this.rayData.set([this.plane.normalX,0,this.plane.normalZ,this.plane.offset],44);
        this.meshCache.update(this.rayData,{enabled:this.meshLOD&&this.useCompute&&!!this.meshPipeline,focus});
        if (this.showGround && !perspective) {
            const s = this.plane.project(local.x,local.z).s;
            this.profile.update(s-1/p[0],s+1/p[0],mpp);
            if (this.profile.revision !== this._linesRevision) this._rebuildLines();
            this.lineData.set(this._clipFromLocal.elements);
            this.lineData[16] = mpp;
        }
    }

    compute(frame,encoder) {
        this.normalGPU.compute(encoder,this.volumeData);
        if(!this.useCompute) { this._hitRevision=-1;return; }
        // Lighting, torch motion and body shadows still shade every frame. Only
        // the exact camera/density intersection is cached; edits invalidate it now.
        if(this.reuseHits && this._hitRevision===this.region.volume.revision
            // Remodeling changes an acceleration structure, not the density.
            // Keep valid intersections while background patches arrive/fade/evict;
            // the next camera or density change will use the latest geometry.
            && this._hitMeshEnabled===this.meshLOD
            && this._hitViewData?.every((value,index)=>value===this.rayData[index])
            && this._hitVolumeData?.every((value,index)=>value===this.volumeData[index])) return;
        const d=this.backend.device,gpu=this.volumeGPU;
        d.queue.writeBuffer(this.traceViewBuffer,0,this.rayData);
        d.queue.writeBuffer(this.traceVolumeBuffer,0,this.volumeData);
        const useMeshes=this.meshLOD&&this.meshCache.draws.length>0;
        if(this.meshPipeline&&useMeshes) {
            const pass=encoder.beginRenderPass({label:'Voxel geometry LOD hits',
                colorAttachments:[{view:this.meshHitView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}],
                depthStencilAttachment:{view:this.meshDepthView,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'discard'}});
            pass.setPipeline(this.meshPipeline);
            for(const record of this.meshCache.draws) {
                const stage=record.stages[record.level];
                if(!stage.indexCount) continue;
                if(!record.bindGroup) record.bindGroup=d.createBindGroup({layout:this.meshPipeline.getBindGroupLayout(0),entries:[
                    {binding:0,resource:{buffer:this.traceViewBuffer}},{binding:1,resource:{buffer:record.uniform}}]});
                pass.setBindGroup(0,record.bindGroup);pass.setVertexBuffer(0,stage.vertexBuffer);pass.setIndexBuffer(stage.indexBuffer,'uint32');
                pass.drawIndexed(stage.indexCount);
            }
            pass.end();
        }
        const pipeline=useMeshes?this.meshTracePipeline:this.tracePipeline;
        if(!this.traceBindGroup||this.boundDensity!==gpu.density||this.boundTracePipeline!==pipeline) {
            this.boundDensity=gpu.density;
            this.boundTracePipeline=pipeline;
            this.traceBindGroup=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
                {binding:0,resource:{buffer:this.traceViewBuffer}},{binding:3,resource:this.hitView},
                ...(useMeshes?[{binding:11,resource:this.meshHitView}]:[]),
                ...[[4,this.traceVolumeBuffer],[5,gpu.columns],[6,gpu.chunkMap],[7,gpu.density],[8,gpu.chunkMaxima],[9,gpu.coarseBounds]]
                    .map(([binding,buffer])=>({binding,resource:{buffer}})),
            ]});
        }
        const pass=encoder.beginComputePass({label:'Voxel ray search'});
        pass.setPipeline(pipeline);pass.setBindGroup(0,this.traceBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this.hitWidth/8),Math.ceil(this.hitHeight/8));pass.end();
        this._hitRevision=this.region.volume.revision;
        this._hitMeshEnabled=this.meshLOD;
        (this._hitViewData??=new Float32Array(this.rayData.length)).set(this.rayData);
        (this._hitVolumeData??=new Float32Array(this.volumeData.length)).set(this.volumeData);
    }
    render({ backend }) { backend.draw(this.rayGeometry,this.useCompute?this.shadeMaterial:this.rayMaterial); }
    renderTransparent(context) { if (this.showGround && !this._perspective) super.renderTransparent(context); }
    dispose() {
        this.normalGPU?.dispose();
        this.meshCache?.dispose();
        this.meshHitTexture?.destroy();this.meshDepthTexture?.destroy();
        this.hitTexture?.destroy();
        this.traceViewBuffer?.destroy();this.traceVolumeBuffer?.destroy();
        if(this.shadeMaterial)this.backend.destroyMaterial(this.shadeMaterial);
        this.rayGeometry?.dispose();
        if (this.rayMaterial) this.backend.destroyMaterial(this.rayMaterial);
        this.rayGeometry = this.rayMaterial = null;
        super.dispose();
    }
}
