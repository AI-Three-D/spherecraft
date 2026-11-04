import { VoxelRegion } from '../core/voxel/VoxelRegion.js';
import { SparseVolumeGPU } from '../core/voxel/SparseVolumeGPU.js';
import { AnthillLighting } from '../core/voxel/AnthillLighting.js';
import { viewStruct, volumeBoundsDeclarationsWGSL, volumeTraversalWGSL } from '../core/voxel/volumeTraversal.wgsl.js';
import { volumeDeclarationsWGSL, volumeFunctionsWGSL } from '../core/voxel/volumeShader.wgsl.js';
import { lightingDeclarationsWGSL, lightingFunctionsWGSL } from '../core/voxel/lighting.wgsl.js';
import { SparseVolumeNormalsGPU, normalDeclarationsWGSL, normalFunctionsWGSL } from '../core/voxel/SparseVolumeNormalsGPU.js';

/** Real GPU assertions against an isolated flat-roof mine. Uses the renderer's
 * device, with separate volume/buffers; the visible mine and its edits are preserved.
 */
export async function verifyLightingGPU(harness) {
    const device = harness.renderer.backend.device;
    const region = new VoxelRegion({
        heightfield: { frame: { origin: { x: 0, y: 131072, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } },
            corner: { x: -32, z: -8 }, spacing: 1, countX: 65, countZ: 17, heights: new Float32Array(65*17).fill(6) },
        rock: { layers: [{ color: [0.5,0.4,0.3] }] }, voxelSize: 0.25, depth: 14,
        carves: [{ shape: { type: 'capsule', a: [-29,0,0], b: [29,0,0], radius: 2.5 } }],
    });
    const mirror = new SparseVolumeGPU(region.volume,device), v = region.volume;
    let normalGPU = new SparseVolumeNormalsGPU(mirror), normalFocus;
    const lighting = new AnthillLighting({ timeOfDay: 12 });
    lighting.running = false;
    lighting.setCarriedLight([0,1,0]);
    const viewData = new Float32Array(48), volumeData = new Float32Array(16);
    volumeData.set([v.minX,v.minY,v.minZ,v.voxelSize]);
    const integers = new Uint32Array(volumeData.buffer);
    integers.set([v.countX,v.countY,v.countZ,v.chunkSize],4);
    integers.set([v.chunksX,v.chunksY,v.chunksZ,mirror.wordsPerChunk],8);
    volumeData[15] = 1; // Deliberately shorter than the 48 m shadow ray.
    viewData[16] = 0.01;
    viewData[17] = 1; // A cutaway must never open a light path.
    viewData.set([mirror.boundsSize,mirror.boundsX,mirror.boundsY,mirror.boundsZ],20);
    viewData[26] = v.densityRange;
    const buffers = [];
    const buffer = (size,usage) => { const b = device.createBuffer({size,usage}); buffers.push(b); return b; };
    const view = buffer(192,64|8), volume = buffer(64,64|8), lights = buffer(lighting.data.byteLength,64|8);
    const output = buffer(96,128|4), read = buffer(96,1|8);
    try {
        const shader = device.createShaderModule({code:`
${viewStruct}
${volumeDeclarationsWGSL}
${volumeBoundsDeclarationsWGSL}
${lightingDeclarationsWGSL}
${normalDeclarationsWGSL}
${volumeFunctionsWGSL.split('// A bounded search')[0]}
${volumeTraversalWGSL}
${lightingFunctionsWGSL}
${normalFunctionsWGSL}
@group(0) @binding(13) var<storage,read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main() {
    result[0] = vec4<f32>(
        lightVisibility(vec3<f32>(0,-2,0), vec3<f32>(0,1,0), 1000.0, false),
        lightVisibility(vec3<f32>(8,-2,0), vec3<f32>(0,1,0), 1000.0, false),
        lightVisibility(vec3<f32>(-24,0,0), vec3<f32>(1,0,0), 48.0, false),
        lightVisibility(vec3<f32>(-24,0,0), vec3<f32>(1,0,0), 48.0, true));
    result[1] = vec4<f32>(anthillIrradiance(vec3<f32>(0,-2.49,0), vec3<f32>(0,1,0), false),0);
    result[2] = vec4<f32>(anthillIrradiance(vec3<f32>(-6,-2.49,0), vec3<f32>(0,1,0), false),
        lightVisibility(vec3<f32>(24,0,0),vec3<f32>(-1,0,0),48.0,false));
    let edge = vec3<f32>(6,0,-0.4);
    let clear = vec3<f32>(6,0,-1);
    result[3] = vec4<f32>(
        lightVisibility(vec3<f32>(-3,0,0),vec3<f32>(1,0,0),6.0,true),
        lightVisibility(vec3<f32>(-3,0,0.4),normalize(edge),length(edge),true),
        lightVisibility(vec3<f32>(-3,0,1),normalize(clear),length(clear),true),
        lightVisibility(vec3<f32>(-3,0,0),vec3<f32>(1,0,0),3.0,true));
    let p = vec3<f32>(-24,-1.75,1.75);
    let e = volume.origin.w*0.0001;
    result[4] = vec4<f32>(
        length(volumeShadingNormal(p+vec3<f32>(e,0,0))-volumeShadingNormal(p-vec3<f32>(e,0,0))),
        length(volumeShadingNormal(p+vec3<f32>(0,e,0))-volumeShadingNormal(p-vec3<f32>(0,e,0))),
        length(volumeShadingNormal(p+vec3<f32>(0,0,e))-volumeShadingNormal(p-vec3<f32>(0,0,e))),
        length(volumeShadingNormal(p)));
    result[5] = vec4<f32>(volumeShadingNormal(vec3<f32>(-2.05,-2.1,0)),0);
}`});
        const pipeline = await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'main'}});
        const sample = async () => {
            mirror.sync(); normalGPU.sync(normalFocus); lighting.update();
            device.queue.writeBuffer(view,0,viewData); device.queue.writeBuffer(volume,0,volumeData);
            device.queue.writeBuffer(lights,0,lighting.data);
            const group = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
                ...[[0,view],[4,volume],[5,mirror.columns],[6,mirror.chunkMap],[7,mirror.density],
                    [8,mirror.chunkMaxima],[9,mirror.coarseBounds],[10,lights],[12,normalGPU.buffer],[13,output],[14,normalGPU.mapBuffer]]
                    .map(([binding,buffer]) => ({binding,resource:{buffer}})),
            ]});
            const encoder = device.createCommandEncoder();
            normalGPU.compute(encoder,volumeData);
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(1); pass.end();
            encoder.copyBufferToBuffer(output,0,read,0,96); device.queue.submit([encoder.finish()]);
            await read.mapAsync(1);
            const result = Array.from(new Float32Array(read.getMappedRange())); read.unmap(); return result;
        };
        const require = (condition,message,data) => { if(!condition) throw new Error(`${message}: ${JSON.stringify(data)}`); };
        const sealed = await sample();
        require(sealed[0] === 0 && sealed[1] === 0 && sealed[2] === 1, 'Sealed roof or long clear ray',sealed);
        require(sealed[11] === 1, 'Reverse shadow ray preserves long clear paths',sealed);
        require(sealed.slice(16,19).every(value=>value<0.005) && Math.abs(sealed[19]-1)<0.001,
            'Smooth unit normals across voxel and chunk borders',sealed.slice(16,20));
        region.apply({shape:{type:'capsule',a:[0,0,0],b:[0,8,0],radius:0.8}});
        const opened = await sample();
        require(opened[0] === 1 && opened[1] === 0, 'Sun shaft must open only the traced path',opened);
        require(sealed[4] > 0.1, 'Carried point light illuminates the cave floor',sealed);
        lighting.setCarriedLight([0,1,0],false);
        const daylight = await sample();
        lighting.setTimeOfDay(9);
        const angled = await sample();
        lighting.setTimeOfDay(0);
        const night = await sample();
        require(daylight[4] > night[4] + 0.5, 'Directional day/night illumination', {daylight,night});
        require(angled[4] === night[4], 'Changing sun angle must move light out of the narrow shaft', {angled,night});
        viewData[17] = 0; viewData[18] = 1; viewData[44] = 1; viewData[47] = -12;
        const inspection = await sample();
        require(inspection.every((value,index) => value === night[index]), 'Camera cut must not affect shadows',inspection);
        lighting.setOccluder([-1,-1,-1],[1,1,1]);
        const body = await sample();
        require(body[2] === 1 && body[3] === 0, 'Miner body casts a local-light shadow',body);
        lighting.setOccluder([-0.2,-1,-0.2],[0.2,1,0.2]);
        const softened = await sample(), profile = softened.slice(12,16);
        require(profile[0] === 0 && profile[1] > 0.05 && profile[1] < 0.95 && profile[2] === 1,
            'Body shadow retains a dark core and a continuous penumbra',profile);
        require(profile[3] === 1, 'A source inside the body proxy must not black out the cave',profile);
        lighting.setOccluder(null);
        lighting.addLight({kind:'lantern',position:[6,1,0],radius:24,intensity:10});
        const installed = await sample();
        require(installed[8] > night[8] + 0.05, 'Installed lantern lights the tunnel floor',installed);
        region.apply({mode:'fill',shape:{type:'ellipsoid',center:[0,0,0],radii:[0.15,3,3]}});
        const thinWall = await sample();
        require(thinWall[2] === 0 && thinWall[11] === 0 && thinWall[8] === night[8],
            'A thin wall blocks both ray directions and installed lighting',thinWall);
        region.apply({mode:'fill',shape:{type:'sphere',center:[0,0,0],radius:3}});
        const blocked = await sample();
        require(blocked[2] === 0, 'Newly filled rock must block a point-light ray',blocked);
        require(blocked[8] === night[8], 'Installed lantern shadow responds to a filled wall',blocked);
        require(Math.hypot(...blocked.slice(20,23).map((value,i)=>value-installed[20+i]))>0.1,
            'Filled terrain invalidates the smooth normal cache',{before:installed.slice(20,23),after:blocked.slice(20,23)});
        normalGPU.dispose();
        normalGPU=new SparseVolumeNormalsGPU(mirror,{maxBytes:(v.chunkSize+4)**3*4});
        normalFocus={x:28,y:-4,z:4};
        await sample();
        const previousResident=[...normalGPU.residents.keys()][0];
        // The sampled surface at (-2.05,-2.1,0) belongs to this chunk. A later
        // density slot must be able to use normal slot zero after camera motion.
        normalFocus={x:-4,y:-4,z:4};
        const relocated=await sample();
        require(previousResident!==[...normalGPU.residents.keys()][0] && normalGPU.capacity===1,
            'Bounded normal cache follows the focus',[...normalGPU.residents.keys()]);
        require(relocated.slice(20,23).every((value,i)=>Math.abs(value-blocked[20+i])<0.00001),
            'Relocated cached normals match the uncapped reference',{reference:blocked.slice(20,23),relocated:relocated.slice(20,23)});
        return {sealed:sealed.slice(0,4),opened:opened.slice(0,4),daylight:daylight[4],night:night[4],
            angled:angled[4],body:body.slice(2,4),penumbra:profile,normalContinuity:sealed.slice(16,20),
            installed:installed[8],thinWall:thinWall.slice(2,3).concat(thinWall[11]),blocked:blocked.slice(0,4),normalRelocation:true};
    } finally {
        normalGPU.dispose();
        mirror.dispose();
        for (const b of buffers) b.destroy();
    }
}
