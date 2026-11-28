// @ts-nocheck
// Portraits of a grass field (GrassPass.js, terrainPass.wgsl.js): a tile of our own blades, made by the blades' rules,
// rendered at load from a set of view directions. Past where blades are drawn one by one, the terrain wears the portrait
// seen from the direction it is seen from: a bidirectional texture of the field (after Boulanger, Pattanaik and
// Bouatouch's grass terrains), so that the far field shows the parallax, occlusion and grain the blades have, made from
// the blades themselves rather than drawn by hand.
//
// Each view is an oblique parallel projection of the periodic field onto the ground: a point at height z shows at
// ground + z cot(elevation) along the view's way, and nearer points (higher, on the same sight line) hide farther ones.
// Colour is the blade's albedo times its height ramp (linear); alpha is the height met (0 between blades: the ground).
// Mean colours per view (the last mip) let the shader take each view's structure apart from its mean, which the
// analytic canopy (grassHue.wgsl.js grassCanopy) gives.

/** Metres across the tile; texels across. */
export const PORTRAIT_PERIOD_M = 4;
export const PORTRAIT_SIZE = 256;
/** View elevations (degrees) and azimuths (degrees; the field looks alike from opposite sides). Layer = e * AZ + a; the last elevation (90) has one layer. */
export const PORTRAIT_ELEVATIONS = Object.freeze([3, 7, 15, 30, 55, 90]);
export const PORTRAIT_AZIMUTHS = Object.freeze([0, 30, 60, 90, 120, 150]);
export const PORTRAIT_LAYERS = (PORTRAIT_ELEVATIONS.length - 1) * PORTRAIT_AZIMUTHS.length + 1;
const TUFTS = 64; // per tile edge: about 4 cm apart
const BLADES_PER_TUFT = 6;
const SEGMENTS = 5;
const SAMPLES = 4;
const MAX_HEIGHT = 1.1;

/** Blades in the tile, and how high the tallest reach (m): the volume (grassVolume.js) is made of the same blades. */
export const FIELD_BLADE_COUNT = TUFTS * TUFTS * BLADES_PER_TUFT;
export const FIELD_MAX_HEIGHT = MAX_HEIGHT;
export const FIELD_SEGMENTS = SEGMENTS;

/** The tile's blades, by the blades' rules (grassWgsl.js): fieldBlade(i) and fieldBladeAt(blade, t). Shared by the
 * portraits and the volume (grassVolume.js), so the two show the same field. */
export const FIELD_BLADES_WGSL = /* wgsl */`
const P: f32 = ${PORTRAIT_PERIOD_M}.0;
const TUFTS: u32 = ${TUFTS}u;
const BLADES: u32 = ${BLADES_PER_TUFT}u;
const SEGS: u32 = ${SEGMENTS}u;
const MAXH: f32 = ${MAX_HEIGHT};

fn pcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
fn step3(a: f32, b: f32, x: f32) -> f32 { let t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }
// Periodic value noise over the tile (cells per tile edge n).
fn pnoise(p: vec2<f32>, n: u32, seed: u32) -> f32 {
    let q = p / P * f32(n);
    let i = vec2<i32>(floor(q));
    let f = q - floor(q);
    let u = f * f * (3.0 - 2.0 * f);
    let m = i32(n);
    let c = array<vec2<i32>, 4>(i, i + vec2<i32>(1, 0), i + vec2<i32>(0, 1), i + vec2<i32>(1, 1));
    var v: array<f32, 4>;
    for (var k = 0; k < 4; k++) {
        let w = ((c[k] % m) + m) % m;
        v[k] = u01(pcg(u32(w.x) * 7919u + u32(w.y) * 104729u + seed));
    }
    return mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y);
}

struct FieldBlade { root: vec2<f32>, fdir: vec2<f32>, tall: f32, width: f32, lean: f32, colour: vec3<f32>, kind: u32 };
fn fieldBlade(blade: u32) -> FieldBlade {
    let tuft = blade / BLADES;
    let k = blade % BLADES;
    let cell = vec2<u32>(tuft % TUFTS, tuft / TUFTS);
    let h0 = pcg(tuft * 9781u + 17u);
    let rootT = (vec2<f32>(cell) + vec2<f32>(u01(h0), u01(pcg(h0)))) * (P / f32(TUFTS));
    // As the blades (grassWgsl.js), but one stand: tufts of their own heights, straw, a few seed heads and rosettes.
    // The field's zones and clumps are not in the tile (it repeats every 4 m, and so would they): the terrain puts the
    // blades' own over it, at their places (grassField.wgsl.js).
    let zone = 0.5;
    let clump = 0.5;
    let lush = 0.5;
    let hk = pcg(h0 + k * 0x9E3779B9u + 5u);
    let r1 = u01(hk); let r2 = u01(pcg(hk + 1u)); let r3 = u01(pcg(hk + 2u)); let r4 = u01(pcg(hk + 3u));
    var tall = (0.3 + 0.12 * lush) * mix(0.75, 1.3, zone) * mix(0.75, 1.25, clump) * mix(0.38, 1.06, r3);
    var width = mix(0.008, 0.015, r1);
    var lean = mix(0.25, 1.4, sqrt(r2)) * 0.45 + 0.15;
    let around = r4 * 6.2831853;
    let spread = 0.035 * sqrt(r2);
    let root = rootT + vec2<f32>(cos(around), sin(around)) * spread;
    let facing = around + (r1 - 0.5) * 0.8;
    let deadShare = 0.045;
    var colour = vec3<f32>(0.112, 0.143, 0.052) * mix(0.82, 1.2, clump) * mix(vec3<f32>(1.08, 1.03, 0.85), vec3<f32>(0.9, 0.99, 1.06), zone);
    var kind = 0u;
    if (u01(pcg(hk + 9u)) < deadShare) { colour = vec3<f32>(0.26, 0.23, 0.17); tall *= 0.75; lean += 0.3; }
    if (k == 0u && u01(pcg(h0 + 31u)) < 0.12) {
        // A seed head over the tuft.
        kind = 1u; tall = max(tall, 0.25) * 1.35 + 0.05; width = 0.006; lean = 0.15;
        colour = vec3<f32>(0.27, 0.23, 0.15);
    }
    if (k == 1u && u01(pcg(h0 + 77u)) < 0.1) { kind = 2u; tall = 0.12; width = 0.03; lean = 0.9; colour = vec3<f32>(0.10, 0.15, 0.055); }
    return FieldBlade(root, vec2<f32>(cos(facing), sin(facing)), tall, width, lean, colour, kind);
}
// A blade at t (0 its root, 1 its tip): where over the ground (m), how high (m), how wide (m). A quadratic curve: up,
// then out along its facing.
fn fieldBladeAt(b: FieldBlade, t: f32) -> vec4<f32> {
    let tipH = 1.0 - 0.55 * min(b.lean, 1.0) * min(b.lean, 1.0);
    let ctrlH = 0.68;
    let s = 1.0 - t;
    let along = b.tall * (2.0 * s * t * (0.22 * b.lean) + t * t * (1.05 * b.lean));
    let z = b.tall * (2.0 * s * t * ctrlH + t * t * tipH);
    var w = b.width * (1.0 - pow(t, 1.6));
    if (b.kind == 1u) { w = select(0.0025, b.width * sin(3.14159 * saturate((t - 0.7) / 0.3)), t >= 0.7); }
    if (b.kind == 2u) { w = b.width * pow(sin(3.14159 * clamp(t * 0.92 + 0.06, 0.0, 1.0)), 0.75); }
    return vec4<f32>(b.root + b.fdir * along, z, w);
}
`;

export const BAKE_WGSL = /* wgsl */`
struct Bake { dir: vec2<f32>, cotE: f32, copies: f32 };
@group(0) @binding(0) var<uniform> bake: Bake;
${FIELD_BLADES_WGSL}
struct Out {
    @builtin(position) clip: vec4<f32>,
    @location(0) @interpolate(flat) colour: vec3<f32>,
    @location(1) t: f32,
    @location(2) z: f32,
};

@vertex
fn vsMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Out {
    let copies = u32(bake.copies);
    let blade = instance / (copies * copies);
    let copy = instance % (copies * copies);
    let b = fieldBlade(blade);
    let level = min(vertex >> 1u, SEGS);
    let side = select(-1.0, 1.0, (vertex & 1u) == 1u);
    let t = f32(level) / f32(SEGS);
    let at = fieldBladeAt(b, t);
    let z = at.z;
    let across = vec2<f32>(-b.fdir.y, b.fdir.x);
    let xy = at.xy + across * (0.5 * at.w * side);
    let colour = b.colour;
    // The oblique projection, and the copy of the tile this instance draws.
    var q = xy + z * bake.cotE * bake.dir;
    let c = vec2<f32>(f32(copy % copies), f32(copy / copies)) - 1.0;
    let sx = select(-1.0, 1.0, bake.dir.x >= 0.0);
    let sy = select(-1.0, 1.0, bake.dir.y >= 0.0);
    q -= vec2<f32>(c.x * sx, c.y * sy) * P;
    var out: Out;
    out.clip = vec4<f32>(q.x / P * 2.0 - 1.0, 1.0 - q.y / P * 2.0, 1.0 - z / MAXH * 0.999, 1.0);
    out.colour = colour;
    out.t = t;
    out.z = z / MAXH;
    return out;
}

@fragment
fn fsMain(in: Out) -> @location(0) vec4<f32> {
    // The blade's own ramp: darker low in it (grassWgsl.js fsMain). Alpha: the height met.
    let ramp = mix(0.22, 1.0, pow(saturate(in.t), 1.15));
    return vec4<f32>(in.colour * ramp, max(in.z, 0.02));
}
`;

const MIP_WGSL = /* wgsl */`
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var target0: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let n = vec2i(textureDimensions(source));
    let p = vec2i(id.xy) * 2;
    var sum = vec4f(0.0);
    for (var k = 0; k < 4; k++) { sum += textureLoad(source, min(p + vec2i(k & 1, k >> 1), n - 1), 0); }
    textureStore(target0, id.xy, sum * 0.25);
}
`;

/** The views: { elevation (deg), azimuth (deg) } per layer. */
export function portraitViews() {
    const views = [];
    for (const e of PORTRAIT_ELEVATIONS.slice(0, -1)) for (const a of PORTRAIT_AZIMUTHS) views.push({ elevation: e, azimuth: a });
    views.push({ elevation: 90, azimuth: 0 });
    return views;
}

/** Renders the portraits. Returns { texture, view, destroy }. */
export async function createGrassPortraits(device, size = PORTRAIT_SIZE) {
    const mips = Math.log2(size) + 1;
    const U = GPUTextureUsage;
    const texture = device.createTexture({
        label: 'Grass portraits', size: [size, size, PORTRAIT_LAYERS], format: 'rgba8unorm', mipLevelCount: mips,
        usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.RENDER_ATTACHMENT | U.COPY_DST | U.COPY_SRC,
    });
    const msaa = device.createTexture({ label: 'Grass portrait samples', size: [size, size], format: 'rgba8unorm', sampleCount: SAMPLES, usage: U.RENDER_ATTACHMENT });
    const depth = device.createTexture({ label: 'Grass portrait depth', size: [size, size], format: 'depth24plus', sampleCount: SAMPLES, usage: U.RENDER_ATTACHMENT });
    const module = device.createShaderModule({ label: 'Grass portraits', code: BAKE_WGSL });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    const pipeline = await device.createRenderPipelineAsync({
        label: 'Grass portraits', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vsMain' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        multisample: { count: SAMPLES },
    });
    const mipModule = device.createShaderModule({ label: 'Grass portrait mips', code: MIP_WGSL });
    const mipPipeline = await device.createComputePipelineAsync({ label: 'Grass portrait mips', layout: 'auto', compute: { module: mipModule, entryPoint: 'main' } });
    const views = portraitViews();
    const blades = TUFTS * TUFTS * BLADES_PER_TUFT;
    const buffers = [];
    const encoder = device.createCommandEncoder({ label: 'Grass portraits' });
    views.forEach((v, layer) => {
        const e = v.elevation * Math.PI / 180, a = v.azimuth * Math.PI / 180;
        const cotE = v.elevation >= 89.9 ? 0 : Math.cos(e) / Math.sin(e);
        // Copies of the tile each instance is drawn in: enough to cover the longest shadow of a blade across it.
        const copies = Math.ceil(MAX_HEIGHT * cotE / PORTRAIT_PERIOD_M) + 3;
        const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uniform, 0, new Float32Array([Math.cos(a), Math.sin(a), cotE, copies]));
        buffers.push(uniform);
        const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        const pass = encoder.beginRenderPass({
            label: `Grass portrait ${layer}`,
            colorAttachments: [{
                view: msaa.createView(), resolveTarget: texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: 0, mipLevelCount: 1 }),
                // Between blades: the ground in their shade.
                clearValue: { r: 0.045, g: 0.04, b: 0.03, a: 0 }, loadOp: 'clear', storeOp: 'discard',
            }],
            depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw((SEGMENTS + 1) * 2, blades * copies * copies);
        pass.end();
    });
    // Mips: the box filter of the linear colours and heights, down to the views' means.
    const levelView = (mip, layer) => texture.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
    const mipPass = encoder.beginComputePass({ label: 'Grass portrait mips' });
    mipPass.setPipeline(mipPipeline);
    for (let layer = 0; layer < PORTRAIT_LAYERS; layer++) {
        for (let mip = 1; mip < mips; mip++) {
            const n = Math.max(1, size >> mip);
            mipPass.setBindGroup(0, device.createBindGroup({ layout: mipPipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: levelView(mip - 1, layer) }, { binding: 1, resource: levelView(mip, layer) },
            ] }));
            mipPass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8));
        }
    }
    mipPass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    msaa.destroy();
    depth.destroy();
    for (const b of buffers) b.destroy();
    return {
        texture, view: texture.createView({ dimension: '2d-array' }), mips,
        destroy: () => texture.destroy(),
    };
}

/**
 * The shader side: the portrait for a sight line, as a factor of mean 1 (its structure apart from its mean). p: ground
 * metres in the tile's frame; slant: sine of the view's elevation; azimuth: the view's way over the ground in that frame
 * (radians); dpx, dpy: the footprint's derivatives in tiles. Needs grassPortraits (texture_2d_array<f32>) and a repeating
 * sampler.
 */
export const GRASS_PORTRAIT_WGSL = /* wgsl */`
const PORTRAIT_ELEV = array<f32, ${PORTRAIT_ELEVATIONS.length}>(${PORTRAIT_ELEVATIONS.map(e => (Math.sin(e * Math.PI / 180)).toFixed(6)).join(', ')});
fn portraitLayer(e: i32, a: i32) -> i32 { return select(e * ${PORTRAIT_AZIMUTHS.length} + a, ${PORTRAIT_LAYERS - 1}, e >= ${PORTRAIT_ELEVATIONS.length - 1}); }
fn portraitTap(s: sampler, uv: vec2<f32>, layer: i32, dpx: vec2<f32>, dpy: vec2<f32>) -> vec4<f32> {
    let c = textureSampleGrad(grassPortraits, s, uv, layer, dpx, dpy);
    let mean = textureLoad(grassPortraits, vec2<i32>(0), layer, ${Math.log2(PORTRAIT_SIZE)});
    return vec4<f32>(c.rgb / max(mean.rgb, vec3<f32>(0.004)), c.a);
}
fn portraitTapLevel(s: sampler, uv: vec2<f32>, layer: i32, lod: f32) -> vec4<f32> {
    let c = textureSampleLevel(grassPortraits, s, uv, layer, lod);
    let mean = textureLoad(grassPortraits, vec2<i32>(0), layer, ${Math.log2(PORTRAIT_SIZE)});
    return vec4<f32>(c.rgb / max(mean.rgb, vec3<f32>(0.004)), c.a);
}
// As grassPortrait, at a mip level (compute shaders: no derivatives).
fn grassPortraitLevel(s: sampler, uv: vec2<f32>, slant: f32, azimuth: f32, lod: f32) -> vec4<f32> {
    var e = 0;
    for (var i = 1; i < ${PORTRAIT_ELEVATIONS.length - 1}; i++) { if (slant >= PORTRAIT_ELEV[i]) { e = i; } }
    let ef = saturate((slant - PORTRAIT_ELEV[e]) / (PORTRAIT_ELEV[e + 1] - PORTRAIT_ELEV[e]));
    let turns = fract(azimuth / 3.14159265) * ${PORTRAIT_AZIMUTHS.length}.0;
    let a0 = i32(floor(turns)) % ${PORTRAIT_AZIMUTHS.length};
    let a1 = (a0 + 1) % ${PORTRAIT_AZIMUTHS.length};
    let af = fract(turns);
    let low = mix(portraitTapLevel(s, uv, portraitLayer(e, a0), lod), portraitTapLevel(s, uv, portraitLayer(e, a1), lod), af);
    let high = mix(portraitTapLevel(s, uv, portraitLayer(e + 1, a0), lod), portraitTapLevel(s, uv, portraitLayer(e + 1, a1), lod), af);
    return mix(low, high, ef);
}
// x: the structure (rgb, mean 1), a: the mean height met.
fn grassPortrait(s: sampler, uv: vec2<f32>, slant: f32, azimuth: f32, dpx: vec2<f32>, dpy: vec2<f32>) -> vec4<f32> {
    var e = 0;
    for (var i = 1; i < ${PORTRAIT_ELEVATIONS.length - 1}; i++) { if (slant >= PORTRAIT_ELEV[i]) { e = i; } }
    let ef = saturate((slant - PORTRAIT_ELEV[e]) / (PORTRAIT_ELEV[e + 1] - PORTRAIT_ELEV[e]));
    // Opposite sides alike: the azimuth over half a turn, in steps of the views.
    let turns = fract(azimuth / 3.14159265) * ${PORTRAIT_AZIMUTHS.length}.0;
    let a0 = i32(floor(turns)) % ${PORTRAIT_AZIMUTHS.length};
    let a1 = (a0 + 1) % ${PORTRAIT_AZIMUTHS.length};
    let af = fract(turns);
    let low = mix(portraitTap(s, uv, portraitLayer(e, a0), dpx, dpy), portraitTap(s, uv, portraitLayer(e, a1), dpx, dpy), af);
    let high = mix(portraitTap(s, uv, portraitLayer(e + 1, a0), dpx, dpy), portraitTap(s, uv, portraitLayer(e + 1, a1), dpx, dpy), af);
    return mix(low, high, ef);
}
`;
