// @ts-nocheck
import {
    GROUND_KIND, GROUND_MIP_WGSL, buildReliefShader, buildResolveShader, buildStoreShader, buildWideResolveShader, buildWideShader,
} from './groundMaterialGenerator.wgsl.js';

const SHAPE = Object.freeze({ blade: 0, twig: 1, leaf: 2, stone: 3, clover: 4 });
const cm = x => x / 100;

// One scattered kind of piece. length, width, root, rise in centimetres.
const piece = (shape, kind, count, o = {}) => ({
    shape: SHAPE[shape], kind: GROUND_KIND[kind], count,
    size: [...(o.length ?? [2, 4]), ...(o.width ?? o.length ?? [2, 4])].map(cm),
    place: [cm(o.root?.[0] ?? 0), cm(o.root?.[1] ?? 0), cm(o.rise ?? 1), o.clump ?? -9],
    style: [o.curl ?? 0, o.comb ?? 0, o.clumpCells ?? 5, o.tall ?? 0],
});
const stones = (count, size, root, o = {}) => piece('stone', 'stone', count, { length: size, width: size, root, rise: 0, ...o, tall: o.flat ?? 0.8, curl: o.angular ?? 0.6 });

/**
 * The close-up surfaces. periodM: metres across the texture. mean: linear albedo far away. slope: largest slope stored.
 * look: [dead blade share or 0, lichen, dead soil, height contrast (per metre)]. deepM: how deep the relief looks close by (parallax), from the lowest to the highest.
 */
export const GROUND_LAYERS = Object.freeze([
    { name: 'grass', periodM: 2.2, mean: [0.078, 0.088, 0.027], slope: 2, look: [0.05, 0, 0.8, 9], pieces: [
        piece('blade', 'straw', 2600, { length: [5, 12], width: [0.25, 0.4], root: [-2.6, -1.2], rise: 1.2, curl: 1.6, comb: 0.5 }),
        piece('blade', 'blade', 15000, { length: [5, 11], width: [0.42, 0.72], root: [-2.2, 0.2], rise: 2.6, curl: 1.3, comb: 0.55, tall: 1, clumpCells: 6 }),
        piece('blade', 'blade', 9000, { length: [6, 14], width: [0.38, 0.68], root: [-1.4, 1.0], rise: 3.4, curl: 1.4, comb: 0.7, tall: 1, clumpCells: 9, clump: -0.05 }),
        piece('clover', 'clover', 700, { length: [1.8, 3.4], root: [0.2, 2.2], rise: 0.6, clumpCells: 5, clump: 0.22 }),
    ] },
    { name: 'dryGrass', periodM: 2.2, mean: [0.116, 0.104, 0.052], slope: 2, look: [0.45, 0, 1, 9], pieces: [
        piece('blade', 'straw', 11000, { length: [7, 18], width: [0.30, 0.55], root: [-2.6, -0.4], rise: 1.6, curl: 1.9, comb: 0.55, tall: 1, clumpCells: 7 }),
        piece('blade', 'straw', 7000, { length: [8, 20], width: [0.28, 0.5], root: [-1.6, 0.8], rise: 3.0, curl: 2.0, comb: 0.65, tall: 1, clumpCells: 9, clump: -0.1 }),
        piece('blade', 'blade', 4200, { length: [5, 12], width: [0.28, 0.45], root: [-2.2, 0.6], rise: 3.4, curl: 1.4, comb: 0.5, tall: 1, clumpCells: 8, clump: 0.08 }),
        piece('twig', 'twig', 16, { length: [6, 16], width: [0.3, 0.6], root: [0, 0.6], rise: 0.6, curl: 0.9 }),
    ] },
    { name: 'forest', periodM: 2.2, mean: [0.072, 0.062, 0.030], slope: 2, look: [0.1, 0.6, 0.5, 12], deepM: 0.03, pieces: [
        piece('blade', 'straw', 5200, { length: [3, 7], width: [0.12, 0.2], root: [0, 0.8], rise: 0.2, curl: 0.3 }),
        piece('leaf', 'leaf', 900, { length: [3.5, 7], width: [1.8, 3.6], root: [0.2, 2.2], rise: 1.0, curl: 0.4 }),
        piece('leaf', 'leaf', 420, { length: [4, 8], width: [2.2, 4.2], root: [1.2, 3.0], rise: 1.4, curl: 0.5, clump: 0 }),
        piece('twig', 'twig', 90, { length: [5, 22], width: [0.25, 0.8], root: [0.6, 2.2], rise: 0.8, curl: 1.2 }),
        piece('twig', 'twig', 9, { length: [40, 90], width: [1.2, 2.4], root: [0.8, 1.6], rise: 1.4, curl: 0.8 }),
        stones(40, [2, 6], [-0.6, 0.4], { angular: 0.2 }),
        piece('blade', 'blade', 1300, { length: [5, 12], width: [0.3, 0.5], root: [0.4, 2], rise: 4.0, curl: 1.6, tall: 1, clump: 0.2 }),
    ] },
    { name: 'dirt', periodM: 2.6, mean: [0.098, 0.074, 0.050], slope: 2, look: [0, 0.2, 0.35, 11], deepM: 0.03, pieces: [
        stones(5200, [0.5, 1.6], [-0.15, 0.25], { angular: 0.5 }),
        stones(620, [1.6, 5], [-0.5, 0.6], { angular: 0.45, clump: -0.15 }),
        stones(46, [5, 11], [-1.6, 0.2], { angular: 0.55 }),
        piece('blade', 'straw', 420, { length: [4, 12], width: [0.18, 0.35], root: [0.4, 1.2], rise: 0.4, curl: 1.2 }),
        piece('twig', 'twig', 34, { length: [4, 14], width: [0.2, 0.5], root: [0.3, 0.9], rise: 0.5, curl: 1.0 }),
        piece('blade', 'blade', 260, { length: [4, 9], width: [0.3, 0.5], root: [0, 0.6], rise: 3, curl: 1.4, clump: 0.3 }),
    ] },
    { name: 'gravel', periodM: 3.2, mean: [0.128, 0.120, 0.106], slope: 2.5, look: [0, 0.7, 0, 5], deepM: 0.07, pieces: [
        stones(5200, [1, 3], [-1.4, 0.4], { angular: 0.75 }),
        stones(2600, [3, 8], [-1.8, 0.8], { angular: 0.85 }),
        stones(620, [8, 19], [-3.2, 1.0], { angular: 0.9, flat: 0.75 }),
        stones(60, [20, 38], [-7, -1], { angular: 0.95, flat: 0.7 }),
        piece('blade', 'straw', 300, { length: [4, 10], width: [0.2, 0.35], root: [0, 2], rise: 1.5, curl: 1.4 }),
    ] },
    { name: 'rock', periodM: 5.5, mean: [0.150, 0.142, 0.128], slope: 2.5, look: [0, 1, 0, 0.55], deepM: 0.1, pieces: [] },
    { name: 'sand', periodM: 3.2, mean: [0.400, 0.310, 0.190], slope: 1, look: [0, 0, 0, 14], pieces: [
        stones(900, [0.4, 1.2], [-0.1, 0.5], { angular: 0.3, clump: 0.05 }),
        stones(40, [1.2, 4], [-0.4, 0.5], { angular: 0.4, clump: 0.1 }),
    ] },
    { name: 'snow', periodM: 6, mean: [0.500, 0.540, 0.600], slope: 1, look: [0, 0, 0, 7], pieces: [] },
    { name: 'mud', periodM: 2.6, mean: [0.080, 0.068, 0.054], slope: 1.6, look: [0, 0.15, 0, 10], deepM: 0.03, pieces: [
        stones(1500, [0.8, 2.4], [-0.7, 0.6], { angular: 0.1 }),
        stones(520, [2.5, 7], [-2.2, 0.4], { angular: 0.12 }),
        stones(60, [7, 16], [-5, -0.6], { angular: 0.15 }),
        piece('twig', 'twig', 12, { length: [8, 26], width: [0.4, 1.0], root: [-0.2, 0.8], rise: 0.6, curl: 1.0 }),
        piece('leaf', 'leaf', 26, { length: [3, 6], width: [1.6, 3], root: [0.2, 0.9], rise: 0.5, curl: 0.4 }),
    ] },
]);

/** Wide patterns: 0 the mosaic of open ground, 1 the face of a cliff, 2 the fields (period in metres). Variants lie side by side in any order, turned around or not. */
export const GROUND_WIDE = Object.freeze([
    { name: 'mosaic', periodM: 256, variants: 3, slope: 1.2, look: [0.45, 0, 0, 0] },
    { name: 'cliff', periodM: 80, variants: 3, slope: 2.5, look: [0.09, 0, 0, 0] },
    { name: 'fields', periodM: 8192, variants: 1, slope: 1, look: [1, 0, 0, 0] },
]);
/** Array layers of the surface texture after the materials': the mosaic's masks and its slopes, the cliff, the fields. */
export const GROUND_WIDE_LAYERS = (() => {
    const [mosaic, cliff] = GROUND_WIDE, masks = GROUND_LAYERS.length, slopes = masks + mosaic.variants;
    const cliffs = slopes + mosaic.variants, fields = cliffs + cliff.variants;
    return Object.freeze({ masks, slopes, cliff: cliffs, fields, count: fields + 1 });
})();

/** What each category's ground averages to from far away: the mix the close ground draws (groundSurface.wgsl.js). */
export function groundCategoryColors() {
    const mean = Object.fromEntries(GROUND_LAYERS.map(l => [l.name, l.mean]));
    const mix = parts => [0, 1, 2].map(i => Object.entries(parts).reduce((sum, [name, share]) => sum + share * mean[name][i], 0));
    const field = mix({ grass: 0.47, dryGrass: 0.33, forest: 0.10, dirt: 0.07, gravel: 0.03 });
    return {
        GRASS: field, FOREST: field, SWAMP: field,
        ROCK: mix({ gravel: 0.5, rock: 0.4, dryGrass: 0.1 }),
        SAND: mix({ sand: 0.75, gravel: 0.25 }), DESERT: mix({ sand: 0.75, gravel: 0.25 }), DIRT: mix({ dirt: 1 }),
        MUD: mix({ mud: 1 }), SNOW: mix({ snow: 1 }), TUNDRA: mix({ snow: 1 }),
    };
}

/**
 * Makes the ground textures on the GPU.
 * albedo (sRGB view): colour, height. surface: slope xy, roughness, openness; then the wide patterns.
 */
export async function createGroundMaterials(device, { size = 1024, reliefSize = 2 * size, layers = GROUND_LAYERS } = {}) {
    const mips = Math.log2(size) + 1;
    const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT, C = GPUShaderStage.COMPUTE;
    const U = GPUTextureUsage;
    const group = (visibility, ...entries) => device.createBindGroupLayout({
        entries: entries.map((e, binding) => ({ binding, visibility, ...e })),
    });
    const uniform = { buffer: { type: 'uniform' } };
    const loaded = { texture: { sampleType: 'unfilterable-float' } };
    const store = format => ({ storageTexture: { access: 'write-only', format } });
    const float = store('rgba16float');
    const shader = (label, code) => device.createShaderModule({ label: `ground ${label}`, code });
    const compute = (label, code, layout, entryPoint = 'main') => device.createComputePipelineAsync({
        label: `ground ${label}`, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: typeof code === 'string' ? shader(label, code) : code, entryPoint },
    });
    const L = {
        relief: group(V | F, uniform, uniform),
        resolve: group(C, uniform, loaded, float, float),
        mip: group(C, loaded, float),
        store: group(C, uniform, loaded, loaded, store('rgba8unorm')),
        wide: group(C, uniform, float),
        wideResolve: group(C, uniform, loaded, loaded, float, float),
    };
    const reliefModule = shader('relief', buildReliefShader());
    const storeModule = shader('store', buildStoreShader());
    const relief = (label, vertex, fragment, depthCompare) => device.createRenderPipelineAsync({
        label: `ground ${label}`, layout: device.createPipelineLayout({ bindGroupLayouts: [L.relief] }),
        vertex: { module: reliefModule, entryPoint: vertex },
        fragment: { module: reliefModule, entryPoint: fragment, targets: [{ format: 'rgba16float' }] },
        depthStencil: { format: 'depth32float', depthCompare, depthWriteEnabled: true },
    });
    const [bed, pieces, resolve, mip, storeAlbedo, storeSurface, storeRaw, wide, wideResolve] = await Promise.all([
        relief('bed', 'bedVertex', 'bedFragment', 'always'),
        relief('pieces', 'pieceVertex', 'pieceFragment', 'greater'),
        compute('resolve', buildResolveShader(), L.resolve),
        compute('mip', GROUND_MIP_WGSL, L.mip),
        compute('store albedo', storeModule, L.store, 'albedo'),
        compute('store surface', storeModule, L.store, 'surface'),
        compute('store raw', storeModule, L.store, 'raw'),
        compute('wide', buildWideShader(), L.wide),
        compute('wide resolve', buildWideResolveShader(), L.wideResolve),
    ]);

    const scratch = [];
    const texture = (label, n, usage, extra = {}) => {
        const t = device.createTexture({ label: `ground ${label}`, size: [n, n], format: 'rgba16float', usage, ...extra });
        scratch.push(t);
        return t;
    };
    const uniforms = (data) => {
        const b = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, data);
        scratch.push(b);
        return b;
    };
    const bind = (layout, ...resources) => device.createBindGroup({
        layout, entries: resources.map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r })),
    });
    const level = (t, baseMipLevel, baseArrayLayer = 0) => t.createView({ dimension: '2d', baseMipLevel, mipLevelCount: 1, baseArrayLayer, arrayLayerCount: 1 });

    // Written as plain storage textures and copied: textures a shader can write are not compressed on the GPU,
    // and the colour is read through an sRGB format.
    const pair = (label, count, format) => {
        const descriptor = { label: `ground ${label}`, size: [size, size, count], mipLevelCount: mips };
        const written = device.createTexture({ ...descriptor, format: 'rgba8unorm', usage: U.STORAGE_BINDING | U.COPY_SRC });
        scratch.push(written);
        return [written, device.createTexture({ ...descriptor, format, usage: U.TEXTURE_BINDING | U.COPY_DST })];
    };
    const [albedoWritten, albedo] = pair('albedo', layers.length, 'rgba8unorm-srgb');
    const [surfaceWritten, surface] = pair('surface', GROUND_WIDE_LAYERS.count, 'rgba8unorm');

    const reliefColor = texture('relief', reliefSize, U.RENDER_ATTACHMENT | U.TEXTURE_BINDING);
    const reliefDepth = texture('relief depth', reliefSize, U.RENDER_ATTACHMENT, { format: 'depth32float' });
    const chain = label => texture(label, size, U.STORAGE_BINDING | U.TEXTURE_BINDING, { mipLevelCount: mips });
    const a = chain('chain a'), b = chain('chain b');
    const [wideRaw, wideBorder] = ['wide raw', 'wide border'].map(label => texture(label, size, U.STORAGE_BINDING | U.TEXTURE_BINDING));

    const layerUniform = (index, spec, n) => {
        const data = new ArrayBuffer(48);
        new Uint32Array(data, 0, 2).set([index, 1009 + 97 * index]);
        new Float32Array(data, 8, 2).set([spec.periodM, n]);
        new Float32Array(data, 16, 8).set([...(spec.mean ?? [0, 0, 0]), spec.slope, ...spec.look]);
        return uniforms(data);
    };
    const scatterUniform = (p, seed) => {
        const data = new ArrayBuffer(64);
        new Uint32Array(data, 0, 4).set([p.shape, p.count, seed, p.kind]);
        new Float32Array(data, 16, 12).set([...p.size, ...p.place, ...p.style]);
        return uniforms(data);
    };
    const finish = (pass, pipelineA, pipelineB, u, arrayA, arrayB, targetA, targetB) => {
        pass.setPipeline(mip);
        for (const t of [a, b]) {
            for (let m = 1; m < mips; m++) {
                pass.setBindGroup(0, bind(L.mip, level(t, m - 1), level(t, m)));
                const n = Math.max(1, Math.ceil((size >> m) / 8));
                pass.dispatchWorkgroups(n, n);
            }
        }
        for (const [pipeline, source, target, arrayLayer] of [[pipelineA, a, targetA, arrayA], [pipelineB, b, targetB, arrayB]]) {
            if (!target) continue;
            pass.setPipeline(pipeline);
            for (let m = 0; m < mips; m++) {
                pass.setBindGroup(0, bind(L.store, u, level(source, m), level(source, mips - 1), level(target, m, arrayLayer)));
                const n = Math.max(1, Math.ceil((size >> m) / 8));
                pass.dispatchWorkgroups(n, n);
            }
        }
    };

    layers.forEach((spec, index) => {
        const encoder = device.createCommandEncoder({ label: `ground ${spec.name}` });
        const u = layerUniform(index, spec, reliefSize);
        const none = scatterUniform(piece('blade', 'bed', 0), 0);
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: reliefColor.createView(), loadOp: 'clear', storeOp: 'store' }],
            depthStencilAttachment: { view: reliefDepth.createView(), depthLoadOp: 'clear', depthClearValue: 0, depthStoreOp: 'discard' },
        });
        pass.setPipeline(bed);
        pass.setBindGroup(0, bind(L.relief, u, none));
        pass.draw(3);
        pass.setPipeline(pieces);
        // Counts are for a 2.2 m texture seen at full density; each piece is drawn again across the edges.
        spec.pieces.forEach((p, k) => {
            pass.setBindGroup(0, bind(L.relief, u, scatterUniform(p, 31 * index + k + 1)));
            pass.draw(36, 4 * p.count);
        });
        pass.end();
        const c = encoder.beginComputePass();
        c.setPipeline(resolve);
        c.setBindGroup(0, bind(L.resolve, u, reliefColor.createView(), level(a, 0), level(b, 0)));
        c.dispatchWorkgroups(size / 8, size / 8);
        finish(c, storeAlbedo, storeSurface, u, index, index, albedoWritten, surfaceWritten);
        c.end();
        device.queue.submit([encoder.finish()]);
    });
    const W = GROUND_WIDE_LAYERS;
    GROUND_WIDE.forEach((spec, index) => {
        const draw = (c, variant, target) => {
            const u = layerUniform(index, { ...spec, look: [spec.look[0], variant, spec.variants, 0] }, size);
            c.setPipeline(wide);
            c.setBindGroup(0, bind(L.wide, u, target.createView()));
            c.dispatchWorkgroups(size / 8, size / 8);
            return u;
        };
        for (let variant = 0; variant < spec.variants; variant++) {
            const encoder = device.createCommandEncoder({ label: `ground ${spec.name}` });
            const c = encoder.beginComputePass();
            if (!variant && spec.variants > 1) draw(c, -1, wideBorder);
            const u = draw(c, variant, wideRaw);
            c.setPipeline(wideResolve);
            c.setBindGroup(0, bind(L.wideResolve, u, wideRaw.createView(), wideBorder.createView(), level(a, 0), level(b, 0)));
            c.dispatchWorkgroups(size / 8, size / 8);
            const masks = [W.masks, null, W.fields][index], slopes = [W.slopes, W.cliff, null][index];
            finish(c, storeRaw, storeSurface, u, masks + variant, slopes + variant, masks === null ? null : surfaceWritten, slopes === null ? null : surfaceWritten);
            c.end();
            device.queue.submit([encoder.finish()]);
        }
    });
    const copy = device.createCommandEncoder({ label: 'ground copy' });
    for (const [from, to] of [[albedoWritten, albedo], [surfaceWritten, surface]]) {
        for (let m = 0; m < mips; m++) {
            copy.copyTextureToTexture({ texture: from, mipLevel: m }, { texture: to, mipLevel: m }, [size >> m, size >> m, to.depthOrArrayLayers]);
        }
    }
    device.queue.submit([copy.finish()]);
    await device.queue.onSubmittedWorkDone();
    for (const resource of scratch) resource.destroy();

    const sampler = maxAnisotropy => device.createSampler({
        addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy,
    });
    return {
        albedo, surface, layers,
        albedoView: albedo.createView(),
        surfaceView: surface.createView(),
        sampler: sampler(4),
        wideSampler: sampler(2),
        destroy() { albedo.destroy(); surface.destroy(); },
    };
}
