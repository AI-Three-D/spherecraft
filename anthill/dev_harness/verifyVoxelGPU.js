import { volumeDeclarationsWGSL, volumeFunctionsWGSL } from '../core/voxel/volumeShader.wgsl.js';
import { rockStructsWGSL, rockFunctionsWGSL } from '../core/voxel/rockShader.wgsl.js';
import { noiseWGSL } from '../core/voxel/noise.js';

const rockReferenceWGSL = /* wgsl */ `
fn rockColorReference(p: vec3<f32>, footprint: f32) -> vec3<f32> {
    let h = surfaceHeight(p.xz);
    let layerCount = i32(rock.header.x);
    let veinCount = i32(rock.header.y);
    var top = h;
    var color = layerColor(0, p, top - p.y, footprint);
    for (var i = 1; i < layerCount; i++) {
        let boundary = min(top, layerBottom(i - 1, p.xz, h));
        let blend = clamp((boundary - p.y) / footprint + 0.5, 0.0, 1.0);
        if (blend > 0.0) {
            color = mix(color, layerColor(i, p, boundary - p.y, footprint), blend);
        }
        top = boundary;
    }
    let depth = h - p.y;
    for (var v = 0; v < veinCount; v++) {
        let vein = rock.veins[v];
        let seed = u32(vein.frequency.w);
        let f = vein.frequency.xyz;
        let field = noise3Gradient(p * f, seed);
        let n = field.x;
        let slope = field.yzw * f * footprint;
        let halfBand = 1.0 - vein.color.a;
        let inside = clamp((halfBand - abs(n)) / max(length(slope), 0.00001) + 0.5, 0.0, 1.0);
        let soft = max(vein.extent.z, footprint);
        let present = smoothstep(vein.extent.x - soft, vein.extent.x + soft, depth)
            * (1.0 - smoothstep(vein.extent.y - soft, vein.extent.y + soft, depth));
        color = mix(color, vein.color.rgb, inside * present);
    }
    return color;
}

`;

/** GPU numerical regression check, callable from the browser benchmark or console.
 * Compares the optimized sampler with the original eight sparse lookups, including
 * chunk borders, surfaces, clamped volume edges and edited chunks. Derivatives are
 * compared with central differences away from interpolation cell boundaries.
 */
export async function verifyVoxelGPU(harness, count = 8192) {
    const { view, region, renderer } = harness;
    const device = renderer.backend.device, v = region.volume;
    view.volumeGPU.sync();
    const positions = new Float32Array(count*4);
    const chunks = [];
    v.forEachChunk(c=>chunks.push(c));
    let seed = 12345;
    const random = () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296; };
    for(let i=0;i<count;i++) {
        let x=v.minX+random()*(v.maxX-v.minX),z=v.minZ+random()*(v.maxZ-v.minZ);
        let y=v.minY+random()*(v.maxY-v.minY);
        if(i%3===0) y=region.surface.sample(x,z)+(random()-0.5)*v.voxelSize*3;
        if(i%3===1 && chunks.length) {
            const c=chunks[Math.floor(random()*chunks.length)];
            const g=[c.cx,c.cy,c.cz].map(a=>a*v.chunkSize+random()*v.chunkSize);
            const axis=Math.floor(i/3)%3;
            g[axis]=Math.round(g[axis]/v.chunkSize)*v.chunkSize+(random()-0.5)*0.002;
            [x,y,z]=g.map((a,k)=>[v.minX,v.minY,v.minZ][k]+a*v.voxelSize);
        }
        positions.set([x,y,z,0],i*4);
    }
    const buffers=[];
    const buffer=(size,usage,data)=>{
        const b=device.createBuffer({size,usage});buffers.push(b);
        if(data)device.queue.writeBuffer(b,0,data);
        return b;
    };
    try {
        const params=buffer(16,64|8,new Float32Array([0,0,v.densityRange,0]));
        const volume=buffer(64,64|8,view.volumeData);
        const rock=buffer(view.rockData.byteLength,64|8,view.rockData);
        const points=buffer(positions.byteLength,128|8,positions);
        const output=buffer(positions.byteLength*2,128|4);
        const read=buffer(positions.byteLength*2,1|8);
        const shader=device.createShaderModule({code:`
struct View { cutSize: vec4<f32> }
@group(0) @binding(0) var<uniform> view: View;
${volumeDeclarationsWGSL}
${volumeFunctionsWGSL.split('// A bounded search')[0]}
${noiseWGSL}
${rockStructsWGSL}
@group(0) @binding(1) var<uniform> rock: Rock;
@group(0) @binding(2) var heights: texture_2d<f32>;
${rockFunctionsWGSL}
${rockReferenceWGSL}
@group(0) @binding(8) var<storage,read> points: array<vec4<f32>>;
@group(0) @binding(9) var<storage,read_write> result: array<vec4<f32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if(id.x>=arrayLength(&points)) { return; }
    let p=points[id.x].xyz;
    let a=volumeDensity(p);
    let b=volumeDensityAcrossChunks(p);
    let q=p*0.1;
    let n=noise3Gradient(q,201u);
    let e=0.001;
    let numeric=vec3<f32>(noise3(q+vec3<f32>(e,0,0),201u)-noise3(q-vec3<f32>(e,0,0),201u),
        noise3(q+vec3<f32>(0,e,0),201u)-noise3(q-vec3<f32>(0,e,0),201u),
        noise3(q+vec3<f32>(0,0,e),201u)-noise3(q-vec3<f32>(0,0,e),201u))/(2.0*e);
    let noiseError=max(abs(n.x-noise3(q,201u)),length(n.yzw-numeric));
    var gradientError=0.0;
    let t=fract((p-volume.origin.xyz)/volume.origin.w);
    let end=volume.origin.xyz+vec3<f32>(volume.counts.xyz-vec3<u32>(1))*volume.origin.w;
    if(all(t>vec3<f32>(0.02))&&all(t<vec3<f32>(0.98))&&all(p>volume.origin.xyz)&&all(p<end)) {
        let d=volume.origin.w*0.005;
        let numericGradient=vec3<f32>(volumeDensity(p+vec3<f32>(d,0,0))-volumeDensity(p-vec3<f32>(d,0,0)),
            volumeDensity(p+vec3<f32>(0,d,0))-volumeDensity(p-vec3<f32>(0,d,0)),
            volumeDensity(p+vec3<f32>(0,0,d))-volumeDensity(p-vec3<f32>(0,0,d)))/(2.0*d);
        let analytic=volumeGradient(p)/volume.origin.w;
        gradientError=length(numericGradient-analytic)/max(1.0,length(analytic));
    }
    result[id.x*2u]=vec4<f32>(a,b,noiseError,gradientError);
    let footprint=select(0.005,0.5,(id.x & 1u)==0u);
    result[id.x*2u+1u]=vec4<f32>(abs(rockColor(p,footprint)-rockColorReference(p,footprint)),0);
}`});
        const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'main'}});
        const mirror=view.volumeGPU;
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:params}},{binding:1,resource:{buffer:rock}},
            {binding:2,resource:view.heightTexture._gpuTexture.texture.createView()},{binding:4,resource:{buffer:volume}},
            {binding:5,resource:{buffer:mirror.columns}},{binding:6,resource:{buffer:mirror.chunkMap}},
            {binding:7,resource:{buffer:mirror.density}},{binding:8,resource:{buffer:points}},
            {binding:9,resource:{buffer:output}},
        ]});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
        encoder.copyBufferToBuffer(output,0,read,0,positions.byteLength*2);device.queue.submit([encoder.finish()]);
        await read.mapAsync(1);
        const data=new Float32Array(read.getMappedRange());
        let densityError=0,signMismatches=0,noiseError=0,gradientError=0,materialError=0;
        for(let i=0;i<count;i++) {
            densityError=Math.max(densityError,Math.abs(data[i*8]-data[i*8+1]));
            if((data[i*8]>0)!==(data[i*8+1]>0))signMismatches++;
            noiseError=Math.max(noiseError,data[i*8+2]);gradientError=Math.max(gradientError,data[i*8+3]);
            materialError=Math.max(materialError,data[i*8+4],data[i*8+5],data[i*8+6]);
        }
        read.unmap();
        const result={count,densityError,signMismatches,noiseError,gradientError,materialError};
        if(densityError>0.0001||signMismatches||noiseError>0.005||gradientError>0.01||materialError>0.00001)
            throw new Error(`Voxel GPU numerical regression: ${JSON.stringify(result)}`);
        return result;
    } finally { for(const b of buffers)b.destroy(); }
}
