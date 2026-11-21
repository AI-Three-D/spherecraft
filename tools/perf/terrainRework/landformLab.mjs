// Native WebGPU natural-landform review (before lakes, rivers and micro detail).
// node landformLab.mjs spec.json outDir [path/to/webgpu/index.js]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const [specFile, out, gpuPath = '../../terrain-lab/node_modules/webgpu/index.js'] = process.argv.slice(2);
if (!specFile || !out) throw new Error('Supply spec.json and output directory');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
fs.mkdirSync(out, { recursive: true });
const root = fileURLToPath(new URL('../../../', import.meta.url));
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const { create, globals } = await import(pathToFileURL(path.resolve(gpuPath)).href);
Object.assign(globalThis, globals);
const gpu = create([]);
// Dawn callbacks require the instance to remain reachable during async work.
globalThis.landformLabGPU = gpu;
const adapter = await gpu.requestAdapter();
const device = await adapter.requestDevice();
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
const { Logger } = await imp('shared/Logger.js');
Logger.setLevel(2);
const { WorldConfigLoader } = await imp('wizard_game/WorldConfigLoader.js');
class DiskLoader extends WorldConfigLoader {
    async _fetchJSON(name) { return JSON.parse(fs.readFileSync(path.join(root, 'wizard_game/world', name), 'utf8')); }
}
const { engineConfig, gameDataConfig } = await new DiskLoader('./world').load();
const planet = gameDataConfig.planets.find(p => p.enabled);
Object.assign(planet.terrain, { baseGenerator: 'lakeLand', regionalTerrain: { enabled: false }, ...spec.terrain });
planet.terrain.features = { ...planet.terrain.features, ...spec.features };
const { PlanetConfig } = await imp('templates/configs/planetConfig.js');
const planetConfig = new PlanetConfig({ ...gameDataConfig.buildPlanetOptions({ surfaceChunkSize: engineConfig.chunkSizeMeters }, planet.id), engineConfig });
const modules = await Promise.all(['terrainCommon', 'surfaceCommon', 'features/featureContinents', 'features/featurePlains',
    'features/featureHills', 'features/featureMountains', 'features/featureCanyons', 'features/featureLoneHills',
    'features/featureMicro', 'features/featureMesoDetail', 'features/featureRivers', 'features/featureErosionSeeds',
    'features/featureErosionFilter', 'base/earthLikeBase', 'base/lakeLandBase'].map(p => imp(`templates/terrain-shaders/${p}.wgsl.js`)));
const bundle = Object.assign({}, ...modules.slice(0, -2));
bundle.baseGenerators = {
    earthLike: { constants: modules.at(-2).createEarthlikeConstants, base: modules.at(-2).createEarthlikeBase },
    lakeLand: { constants: modules.at(-1).createLakeLandConstants, base: modules.at(-1).createLakeLandBase },
};
if (spec.compose) {
    const original = bundle.baseGenerators.lakeLand.base;
    const candidate = fs.readFileSync(spec.compose.file, 'utf8');
    bundle.baseGenerators.lakeLand.base = options => original(options)
        .replace('fn landBands_d(', candidate + '\nfn landBands_d(')
        .replace('out.b0 = b0;', `out.b0 = b0;\n out = ${spec.compose.fn}(unitDir, seed, regional, out);`);
}
const tileTypes = await imp('templates/configs/tileTypes.js');
const { createTerrainThemeForPlanet } = await imp('wizard_game/TerrainThemeFactory.js');
const theme = createTerrainThemeForPlanet({ ...tileTypes, terrainShaderBundle: bundle }, planetConfig);
const { TextureCache } = await imp('core/texture/textureCache.js');
const { WebGPUTerrainGenerator } = await imp('core/world/webgpuTerrainGenerator.js');
const gen = new WebGPUTerrainGenerator(device, engineConfig.seed, engineConfig.chunkSizeMeters,
    engineConfig.macroConfig, engineConfig.splatConfig, new TextureCache(), { planetConfig, terrainTheme: theme });
gen._terrainUniformScratch = new ArrayBuffer(1024);
gen._fillTerrainUniformScratch(0, 0, 128, 1 << 20, 0);
const uniform = device.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(uniform, 0, gen._terrainUniformScratch);
const { createAdvancedTerrainComputeShader } = await imp('core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js');
const code = createAdvancedTerrainComputeShader(gen._getAdvancedTerrainShaderOptions({ waterCarve: false, lakeTable: null })) + `
@group(0) @binding(20) var<storage,read> labDirs: array<vec4<f32>>;
@group(0) @binding(21) var<storage,read_write> labOut: array<vec4<f32>>;
@compute @workgroup_size(64) fn labMain(@builtin(global_invocation_id) id:vec3<u32>) {
 if(id.x >= arrayLength(&labDirs)) { return; }
 let p=normalize(labDirs[id.x].xyz);
 let b=landBands_d(uniforms.seed,p);
 let land=b.b0+b.b1+b.b2+b.b3;
 let h=${spec.shapeOnly ? 'calderaShape_d(p, uniforms.seed).height' : spec.includeOcean
     ? 'dMix(b.ocean, land, b.landBlend)*maxTerrainHeightM()'
     : 'land*maxTerrainHeightM()'};
 let g=(h.yzw-p*dot(p,h.yzw))/noiseReferenceRadiusM();
 labOut[id.x]=vec4<f32>(h.x,g);
}
`;
const module = device.createShaderModule({ code });
const messages = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
if (messages.length) throw new Error(JSON.stringify(messages));
const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'labMain' } });
async function sample(dirs) {
    const result = [];
    for (let offset = 0; offset < dirs.length; offset += 16384) {
        const points = dirs.slice(offset, offset + 16384);
        const data = new Float32Array(points.flatMap(p => [...p, 0]));
        const input = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const output = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const read = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(input, 0, data);
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: uniform } }, { binding: 20, resource: { buffer: input } }, { binding: 21, resource: { buffer: output } },
        ] });
        const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(points.length / 64)); pass.end();
        enc.copyBufferToBuffer(output, 0, read, 0, data.byteLength); device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(read.getMappedRange());
        for (let k = 0; k < values.length; k += 4) result.push(Array.from(values.slice(k, k + 4)));
        read.unmap(); input.destroy(); output.destroy(); read.destroy();
    }
    if (result.some(row => row.some(v => !Number.isFinite(v))) || errors.length) throw new Error(JSON.stringify(errors));
    return result;
}
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const radius = planetConfig.radius;
const origin = Object.values(planetConfig.origin ?? { x:0, y:0, z:0 });
for (const m of spec.maps ?? []) {
    const n = norm(m.dir), px = m.px ?? 256, size = m.sizeM ?? 40000;
    const e1 = norm(cross(n, Math.abs(n[1]) > .9 ? [1,0,0] : [0,1,0])), e2 = cross(n, e1);
    const dirs = [];
    for (let j=0;j<px;j++) for(let i=0;i<px;i++) dirs.push(norm(n.map((v,k) => v*radius + e1[k]*(i/(px-1)-.5)*size + e2[k]*(.5-j/(px-1))*size)));
    const values = await sample(dirs), heights = values.map(v => v[0]);
    const cell = size/(px-1), lo = Math.min(...heights), hi = Math.max(...heights);
    const png = new PNG({ width:px, height:px });
    let maxSlope=0, steep=0, maxGradientError=0;
    for(let j=0;j<px;j++) for(let i=0;i<px;i++) {
        const k=j*px+i;
        const H=(x,y)=>heights[Math.min(px-1,Math.max(0,y))*px+Math.min(px-1,Math.max(0,x))];
        const dx=(H(i+1,j)-H(i-1,j))/(2*cell), dy=(H(i,j-1)-H(i,j+1))/(2*cell), slope=Math.hypot(dx,dy);
        maxSlope=Math.max(maxSlope,slope); if(slope>1)steep++;
        if(i>0&&j>0&&i<px-1&&j<px-1) {
            const g=values[k].slice(1), a=g.reduce((s,v,c)=>s+v*e1[c],0), b=g.reduce((s,v,c)=>s+v*e2[c],0);
            maxGradientError=Math.max(maxGradientError,Math.hypot(dx-a,dy-b));
        }
        const shade=Math.max(.1,(-dx+dy+1.4)/Math.sqrt(dx*dx+dy*dy+1)/Math.sqrt(3.96));
        const t=(heights[k]-lo)/Math.max(1,hi-lo), col=[90+150*t,140+70*t,80+120*t];
        for(let c=0;c<3;c++)png.data[k*4+c]=Math.min(255,col[c]*(.35+.8*shade));
        png.data[k*4+3]=255;
    }
    fs.writeFileSync(path.join(out, m.name+'.png'), PNG.sync.write(png));
    fs.writeFileSync(path.join(out, m.name+'.json'), JSON.stringify({ px,size,n,e1,e2,radius,origin,heights }));
    console.log(JSON.stringify({ map:m.name, min:lo,max:hi,cellM:cell,maxSlope,steepFrac:steep/values.length,maxGradientError }));
}
if(spec.points) console.log(JSON.stringify({ points:await sample(spec.points) }));
if(spec.gradientCheck) {
    const points=[], frames=[];
    let state=731;
    const rand=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const step=2;
    for(const centre of spec.gradientCheck) {
        const c=norm(centre),a=norm(cross(c,Math.abs(c[1])>.9?[1,0,0]:[0,1,0])),b=cross(c,a);
        for(let i=0;i<256;i++) {
            const x=(rand()-.5)*20000,y=(rand()-.5)*20000;
            const p=norm(c.map((v,k)=>v*radius+a[k]*x+b[k]*y));
            const e1=norm(cross(p,Math.abs(p[1])>.9?[1,0,0]:[0,1,0])),e2=cross(p,e1);
            points.push(p,...[e1,e2].flatMap(e=>[-1,1].map(sign=>norm(p.map((v,k)=>v*radius+e[k]*step*sign)))));
            frames.push([e1,e2]);
        }
    }
    const rows=await sample(points);
    let maxError=0,maxSlope=0,active=0;
    frames.forEach(([a,b],i)=>{
        const row=rows[i*5],g=row.slice(1);
        if(row[0]===0)return;
        active++;
        const fd=[(rows[i*5+2][0]-rows[i*5+1][0])/(2*step),(rows[i*5+4][0]-rows[i*5+3][0])/(2*step)];
        const an=[a,b].map(e=>e.reduce((s,v,k)=>s+v*g[k],0));
        maxError=Math.max(maxError,Math.hypot(fd[0]-an[0],fd[1]-an[1]));
        maxSlope=Math.max(maxSlope,Math.hypot(...g));
    });
    console.log(JSON.stringify({gradientCheck:{field:spec.shapeOnly?'calderaShape':'completeLand',points:frames.length,active,maxSlope,maxError,stepM:step}}));
}
if(spec.globe) {
    const w=spec.globe.w??360,h=spec.globe.h??180,dirs=[];
    for(let j=0;j<h;j++)for(let i=0;i<w;i++){
        const lat=Math.PI/2-(j+.5)/h*Math.PI,lon=(i+.5)/w*2*Math.PI-Math.PI;
        dirs.push([Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)]);
    }
    const values=await sample(dirs),buf=Buffer.alloc(values.length*2);
    values.forEach((v,k)=>buf.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v[0]))),k*2));
    fs.writeFileSync(path.join(out,'globe.i16'),buf);
}
if(spec.benchmark) {
    const feature = typeof spec.benchmarkCompare === 'string' ? spec.benchmarkCompare : 'calderas';
    if (!['calderas', 'tectonicRelief'].includes(feature)) throw new Error('Unknown landform benchmark feature');
    const generators=[gen];
    if(spec.benchmarkCompare) {
        const terrain=Object.assign(Object.create(Object.getPrototypeOf(gen.terrainConfig)),gen.terrainConfig,
            {[feature]:{...gen[feature],enabled:!gen[feature].enabled}});
        const otherPlanet=new PlanetConfig({...gameDataConfig.buildPlanetOptions({surfaceChunkSize:engineConfig.chunkSizeMeters},planet.id),
            engineConfig,terrainGeneration:terrain});
        const otherTheme=createTerrainThemeForPlanet({...tileTypes,terrainShaderBundle:bundle},otherPlanet);
        generators.push(new WebGPUTerrainGenerator(device,engineConfig.seed,engineConfig.chunkSizeMeters,
            engineConfig.macroConfig,engineConfig.splatConfig,new TextureCache(),{planetConfig:otherPlanet,terrainTheme:otherTheme}));
    }
    for(const generator of generators) {
        await generator.initialize();
        generator._quadtreeSplatPrimeCount=3;generator._quadtreeSplatProbePassCount=3;generator._quadtreeSplatDiagCount=3;
    }
    const {TileGenerator}=await imp('core/world/quadtree/tileGenerator.js');
    const {TileAddress}=await imp('core/world/quadtree/tileAddress.js');
    const {dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
    const tiles=[];
    for(const dir of spec.benchmark) {
        const {face,u,v}=dirToFaceUV(norm(dir));
        for(const depth of [8,11])for(const [dx,dy] of [[0,0],[1,0],[0,1],[1,1]]) {
            const grid=1<<depth;
            tiles.push(new TileAddress(face,depth,Math.min(grid-1,Math.floor(u*grid)+dx),Math.min(grid-1,Math.floor(v*grid)+dy)));
        }
    }
    const runners=generators.map(generator=>({enabled:generator[feature].enabled,rounds:[],
        tileGen:new TileGenerator(generator,{textureSize:128,requiredTypes:['height','normal','tile','splatData','splatIndex','splatValid'],enableSplat:true,
            textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'}})}));
    for(let round=0;round<6;round++) {
        const sums=new Map(runners.map(r=>[r,0]));
        const order=round%2?[...runners].reverse():runners;
        for(const addr of tiles) {
            for(const runner of order) {
                const started=performance.now();
                const textures=await runner.tileGen._generateTileInternal(addr,{trackStats:false});
                await device.queue.onSubmittedWorkDone();
                for(const texture of Object.values(textures))texture._gpuTexture.texture.destroy();
                sums.set(runner,sums.get(runner)+performance.now()-started);
            }
        }
        if(round>0)for(const runner of runners)runner.rounds.push(sums.get(runner)/tiles.length);
    }
    if(errors.length)throw new Error(JSON.stringify(errors));
    for(const runner of runners)console.log(JSON.stringify({benchmark:{feature,enabled:runner.enabled,tiles:tiles.length,textureSize:128,roundsMsPerTile:runner.rounds,
        medianMsPerTile:[...runner.rounds].sort((a,b)=>a-b)[2],paired:runners.length>1,
        includes:'height, normal, material, splat IDs and weights; CPU submission and GPU fence; warm lake table'}}));
}
device.destroy();
