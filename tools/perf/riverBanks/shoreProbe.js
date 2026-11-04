// Page-side probe: sample the production shore weights over the same cross
// section as transectAt. Heights omit tile micro detail; slopes use 0.5 m
// finite differences. No production shader or water data is changed.
import { transectAt } from './transectProbe.js';
import { riverShapeAt } from '../../../core/world/water/riverShapeNoise.js';
import { createAdvancedTerrainComputeShader } from '../../../core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js';

export async function shoreTransect({ view, halfM = 25, stepM = 0.5 }) {
    const section = await transectAt({ view, halfM, stepM });
    const g = window.gameEngine, gen = g.terrainGenerator, w = g.waterGpuData;
    const device = w.device, rec = g.waterService.riverRecs.get(section.rid);
    const P = rec.points, st = rec.stride, k = section.k, R = w.R;
    const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
    const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    const at = q => Array.from(P.slice(q*st, q*st+3));
    const d = at(k), tangent = norm(at(k+1).map((v,i) => v-at(k-1)[i]));
    const left = norm(cross(d,tangent));
    const off = riverShapeAt(section.s, section.rid, Math.max(section.hw,0.5), { ...w.carve, bankDetail:0 }).off;
    const dirs = section.ns.map(n => norm(d.map((v,i) => v+left[i]*(off+n)/R)));
    const alongDirs = dirs.flatMap(dir => [-0.5,0.5].flatMap(x => [...norm(dir.map((v,i) => v+tangent[i]*x/R)),0]));
    const alongH = await g.waterService._sampler.sampleDirsCarved(Float32Array.from(alongDirs));
    const data = new Float32Array(dirs.length*8);
    const slopes = dirs.map((dir,i) => {
        const a = Math.max(0,i-1), b = Math.min(dirs.length-1,i+1);
        const across = (section.carved[b]-section.carved[a])/((b-a)*stepM);
        const gradient = Math.hypot(across,alongH[2*i+1]-alongH[2*i]);
        const slope = gradient/Math.sqrt(1+gradient*gradient);
        data.set([...dir,section.carved[i],slope,0,0,0],8*i);
        return slope;
    });
    const terrainSource = createAdvancedTerrainComputeShader(gen._getAdvancedTerrainShaderOptions({ waterCarve:true, riverBankDetail:true }));
    const hasGrassFringe = terrainSource.includes('fn riverCarveShoreProfile');
    const source = terrainSource+`
struct ShoreReviewInput { point: vec4<f32>, params: vec4<f32>, }
@group(3) @binding(0) var<storage,read> shoreReviewIn: array<ShoreReviewInput>;
@group(3) @binding(1) var<storage,read_write> shoreReviewOut: array<vec4<f32>>;
@compute @workgroup_size(64)
fn shoreReviewMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= arrayLength(&shoreReviewIn)) { return; }
    let p = shoreReviewIn[gid.x];
    let dir = normalize(p.point.xyz);
    let h = p.point.w;
    let s = p.params.x;
    let lake = waterLakeHitView(dir,h-3.0,riverCarveLakeSampler,true,true);
    var lakeMud = 0.0;
    if (lake.level > WATER_NO_LAKE) { lakeMud = riverCarveLakeBed(lake.level,dir,h,s); }
    let shore = riverCarveShoreWeights(dir,h,s);
    let river = waterRiverAt(dir,h);
    shoreReviewOut[2u*gid.x] = vec4<f32>(shore.x,riverCarveRiverShore(dir,h,s).x,lakeMud,lake.level);
    shoreReviewOut[2u*gid.x+1u] = vec4<f32>(${hasGrassFringe?'shore.z':'0.0'},select(WATER_NO_LAKE,river.etaM,river.near),river.distM-river.halfWidthM,lake.cover);
}`;
    const resources = [];
    const buffer = (size,usage) => { const b = device.createBuffer({size,usage}); resources.push(b); return b; };
    try {
        const module = device.createShaderModule({label:'ShoreReview',code:source});
        const pipeline = await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'shoreReviewMain'}});
        gen._fillTerrainUniformScratch(0,0,128,1,0);
        const uniform = buffer(gen._terrainUniformScratch.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(uniform,0,gen._terrainUniformScratch);
        const input = buffer(data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(input,0,data);
        const size = dirs.length*32;
        const output = buffer(size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
        const read = buffer(size,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
        const r = w.resources;
        const group0 = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
        const group1 = device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[
            {binding:1,resource:{buffer:r.index}}, {binding:2,resource:{buffer:r.params}}, {binding:3,resource:{buffer:r.rivers}},
            {binding:7,resource:{buffer:r.lakes}}, {binding:8,resource:r.masks}, {binding:9,resource:gen._lakeMaskSampler},
        ]});
        const group2 = device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[]});
        const group3 = device.createBindGroup({layout:pipeline.getBindGroupLayout(3),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0,group0); pass.setBindGroup(1,group1); pass.setBindGroup(2,group2); pass.setBindGroup(3,group3);
        pass.dispatchWorkgroups(Math.ceil(dirs.length/64)); pass.end();
        encoder.copyBufferToBuffer(output,0,read,0,size); device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(read.getMappedRange());
        const rows = section.ns.map((n,i) => ({n,ground:section.carved[i],slope:slopes[i],mud:result[8*i],riverMud:result[8*i+1],lakeMud:result[8*i+2],lakeLevel:result[8*i+3],grassFringe:result[8*i+4],riverLevel:result[8*i+5],beyondRiver:result[8*i+6],lakeCover:result[8*i+7]}));
        read.unmap();
        return {rid:section.rid,k,water:section.level,hw:section.hw,stepM,hasGrassFringe,rows};
    } finally {
        for (const b of resources) b.destroy();
    }
}
