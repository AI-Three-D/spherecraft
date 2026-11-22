// Shared WGSL for the volumetric cloud passes. All distances are kilometres,
// all positions are relative to the planet centre.

/** Mirrors VolumetricCloudsModule#_writeUniforms; every field is a vec4. */
export const CLOUD_UNIFORMS_WGSL = /* wgsl */`
struct CloudUniforms {
    camPos: vec4f,      // xyz camera, w time (s)
    camRight: vec4f,    // xyz, w projection[0]
    camUp: vec4f,       // xyz, w projection[5]
    camBack: vec4f,     // xyz (view +Z), w projection[8]
    frameInfo: vec4f,   // x projection[9], y frame index, zw cloud target size
    prevRight: vec4f,
    prevUp: vec4f,
    prevBack: vec4f,
    prevInfo: vec4f,    // x previous projection[9], yzw camPos - prevCamPos
    sun: vec4f,         // xyz direction to sun, w illuminance
    planet: vec4f,      // ground radius, cloud bottom radius, cloud top radius, atmosphere top radius
    scales: vec4f,      // 1/shape tile, 1/detail tile, 1/weather tile, 1/large weather tile
    coverage: vec4f,    // coverage, weather contrast, cloud type, type variance
    density: vec4f,     // extinction per km, detail erosion, detail warp, scattering albedo
    windShape: vec4f,   // xyz shape noise offset, w spatial filter strength (no-temporal mode)
    windDetail: vec4f,  // xyz detail noise offset, w top skew (km)
    phase: vec4f,       // forward g, back g, back lobe weight, powder strength
    light: vec4f,       // ambient strength, multi-scatter extinction, scattering, phase factors
    march: vec4f,       // max steps, min step, step growth per km, max step
    march2: vec4f,      // first light step, radians per cloud pixel, temporal blend, debug mode
    shadowE1: vec4f,    // xyz shadow-map axis, w extent
    shadowE2: vec4f,    // xyz shadow-map axis, w centre along e1; map plane normal is cross(e1, e2)
    shadowInfo: vec4f,  // x centre along e2, y plane offset along its normal, z shadow fade (0 = off, map not updated), w layer step fit (fraction of maxSteps; 0 = off)
    windDir: vec4f,     // xyz unit wind direction, w shape offset mode (0 regional channels, 1 slow, 2 none)
    systems: vec4f,     // x 1/weather-system tile, y system strength, z system warp, w pattern offset
    quality: vec4f,     // x interleave factor, yz this frame's interleave offset, w light steps
    lod: vec4f,         // x far-proxy weight (0 raymarch .. 1 slab proxy), y weather evolution (km), z boil rise (km), w history clip (sigmas)
    atmoRayleigh: vec4f, // xyz Rayleigh scattering (1/km), w Rayleigh scale height (km)
    atmoMie: vec4f,     // x Mie scattering, y Mie extinction (1/km), z Mie scale height (km), w Mie g
    atmoOzone: vec4f,   // xyz ozone absorption (1/km), w ozone peak altitude (km)
    atmoExtra: vec4f,   // x ozone half width (km), y ground albedo, z twilight softness (cos of sun angle), w 1 = no temporal (spatial filter)
    sceneDepth: vec4f,  // x projection[10], y projection[14], z km per depth unit, w 1 when a scene depth is bound
    ambientFloor: vec4f, // rgb radiance added to cloud ambient (night sky, moon); host supplied. w step footprint factor
    extra: vec4f,       // x width of the detail-erosion transition, yz far-average footprint range (km, z 0 = off), w far-average density scale
    moon: vec4f,        // xyz direction to the moon, w illuminance (0 = no moonlight)
    march3: vec4f,      // x light sharing (cloud samples per lighting evaluation; 1 = every sample), y longest reuse along the ray (km), z cloud shape (0 cut, > 0 domes of that height scale), w sunset depth (transmittance LUT; 1 = physical)
    shape2: vec4f,      // x giant share of coverage (0 = off), y giant height (core scale), z giant size (x shape tile), w popcorn top (layer fraction)
    look: vec4f,        // x in-scattering probability strength (HZD; 0 = off), y sideways sky occlusion (0 = off), z in-scattering gain, w sunlight-colour altitude scale (1 = physical)
    look2: vec4f,       // x dome edge sharpness (density gain), y cauliflower head strength, z dusk sky-light boost, w 1 = stratified step phases (no-temporal mode)
    look3: vec4f,       // x step-plane anchor lattice (km; 0 = planet centre), y detail pixel-footprint factor (0 = off)
    look4: vec4f,       // x twilight light strength, y detail transmittance cutoff, z spatial grid (0 full, 1 checkerboard, 2–3 block width), w edge wisps (0 = off)
    look5: vec4f,       // x interior density variation, y isolated puff suppression, z daylight sky fill, w daylight sun gain
    banks: vec4f,       // x distant bank strength, yz transition distances (km), w inverse bank tile size
    alto: vec4f,        // x altocumulus strength, yz base and top radii, w inverse tile size
    weatherStyle: vec4f, // cloud presence, stratiform deck, rain shading, low stratus
    lowCloud: vec4f,    // base radius, top radius, inverse tile size
    groundMist: vec4f,  // strength, top radius, scale height, extinction (1/km)
    march4: vec4f,      // x transmittance threshold for sharing light, y proxy crossfade, z stretched tower preview, w broad deck preview
    historyWind: vec4f, // xyz shape advection since last frame (km), w residual evolution (km)
    historyMotion: vec4f, // x ray refresh parity, y closest distance at which to test clear rays (km)
    cacheU: vec4f,      // xyz horizontal cache axis
    cacheV: vec4f,      // xyz second horizontal cache axis
    cacheGrid: vec4f,   // xy origin in cache axes (km), z weather extent, w light extent
    budget: vec4f,     // x near distance (km), y max near samples, z rain interpolation, w tier active
}
`;

export const CLOUD_UNIFORM_VEC4_COUNT = 54;

export const CLOUD_MATH_WGSL = /* wgsl */`
const PI: f32 = 3.14159265358979;
const FAR_DEPTH: f32 = 1.0e6;

fn remap(v: f32, lo: f32, hi: f32, newLo: f32, newHi: f32) -> f32 {
    return newLo + (v - lo) * (newHi - newLo) / (hi - lo);
}

fn remapSat(v: f32, lo: f32, hi: f32, newLo: f32, newHi: f32) -> f32 {
    return saturate(remap(v, lo, hi, newLo, newHi));
}

// Returns (near, far); near > far means a miss.
fn raySphere(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
    let lr = length(ro);
    let b = dot(ro, rd);
    let c = (lr - radius) * (lr + radius);
    let disc = b * b - c;
    if (disc < 0.0) { return vec2f(1.0e30, -1.0e30); }
    let s = sqrt(disc);
    return vec2f(-b - s, -b + s);
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1.0e-4);
    return (1.0 - g2) / (4.0 * PI * denom * sqrt(denom));
}

fn rayleighPhase(cosTheta: f32) -> f32 {
    return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// Interleaved gradient noise; animated per frame for temporal integration.
fn ign(p: vec2f) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

// Ray-start jitter: interleaved gradient noise across pixels (neighbourhoods cover the range
// evenly, so it reads as fine grain, not white-noise speckle), stepped by the golden ratio over
// each pixel's own samples (one per interleave cycle) so the temporal blend averages it evenly.
fn rayJitter(pixel: vec2u) -> f32 {
    let cycle = floor(u.frameInfo.y / (u.quality.x * u.quality.x));
    return fract(ign(vec2f(pixel)) + cycle * 0.61803398875);
}

// Catmull-Rom (bicubic) filtering from five bilinear taps. Bilinear resampling of a low-res or
// reprojected image blurs it a little more every frame; this keeps edges.
fn sampleCatmullRom(tex: texture_2d<f32>, samp: sampler, uv: vec2f) -> vec4f {
    let size = vec2f(textureDimensions(tex));
    let samplePos = uv * size;
    let texPos1 = floor(samplePos - 0.5) + 0.5;
    let f = samplePos - texPos1;
    let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    let w3 = f * f * (-0.5 + 0.5 * f);
    let w12 = w1 + w2;
    let p0 = (texPos1 - 1.0) / size;
    let p3 = (texPos1 + 2.0) / size;
    let p12 = (texPos1 + w2 / w12) / size;
    var sum = textureSampleLevel(tex, samp, vec2f(p12.x, p0.y), 0.0) * (w12.x * w0.y);
    sum += textureSampleLevel(tex, samp, vec2f(p0.x, p12.y), 0.0) * (w0.x * w12.y);
    sum += textureSampleLevel(tex, samp, p12, 0.0) * (w12.x * w12.y);
    sum += textureSampleLevel(tex, samp, vec2f(p3.x, p12.y), 0.0) * (w3.x * w12.y);
    sum += textureSampleLevel(tex, samp, vec2f(p12.x, p3.y), 0.0) * (w12.x * w3.y);
    let norm = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    return sum / norm;
}

// pix in framebuffer pixels (y down). Works for off-centre projections.
fn cameraRay(pix: vec2f, size: vec2f, right: vec4f, up: vec4f, back: vec4f, p9: f32) -> vec3f {
    let ndc = vec2f(pix.x / size.x * 2.0 - 1.0, 1.0 - pix.y / size.y * 2.0);
    let x = (ndc.x + back.w) / right.w;
    let y = (ndc.y + p9) / up.w;
    return normalize(right.xyz * x + up.xyz * y - back.xyz);
}

// Nearest of the corners under one or more cloud pixels. Full-resolution rays need one load.
fn nearestSceneDepth(depth: texture_depth_2d, first: vec2u, last: vec2u, size: vec2u) -> f32 {
    let dims = textureDimensions(depth);
    let lo = (first * dims) / size;
    let hi = max(lo + 1u, ((last + 1u) * dims) / size) - 1u;
    var z = textureLoad(depth, lo, 0);
    if (any(lo != hi)) {
        z = min(min(z, textureLoad(depth, vec2u(hi.x, lo.y), 0)),
            min(textureLoad(depth, vec2u(lo.x, hi.y), 0), textureLoad(depth, hi, 0)));
    }
    return z;
}
`;

// Single-scattering atmosphere for sun colour, cloud ambient light and (in the lab) the sky.
// Coefficients come from the uniforms (VolumetricCloudsModule planet.atmosphere) so a host can
// match its own sky; the defaults are Earth's.
// Requires: u: CloudUniforms.
export const CLOUD_ATMOSPHERE_WGSL = /* wgsl */`
const TRANSMITTANCE_LUT_SIZE = vec2f(256.0, 64.0);
const AMBIENT_LUT_WIDTH: f32 = 64.0;
const AMBIENT_LUT_ROWS: f32 = 3.0;
const AMBIENT_MU_MIN: f32 = -0.45;

struct AtmoMedium {
    rayleigh: vec3f,
    mie: vec3f,
    extinction: vec3f,
}

fn atmoMedium(altitude: f32) -> AtmoMedium {
    let h = max(altitude, 0.0);
    let rd = exp(-h / u.atmoRayleigh.w);
    let md = exp(-h / u.atmoMie.z);
    let oz = max(0.0, 1.0 - abs(h - u.atmoOzone.w) / u.atmoExtra.x);
    var m: AtmoMedium;
    m.rayleigh = u.atmoRayleigh.xyz * rd;
    m.mie = vec3f(u.atmoMie.x * md);
    m.extinction = m.rayleigh + vec3f(u.atmoMie.y * md) + u.atmoOzone.xyz * oz;
    return m;
}

// Bruneton/Hillaire transmittance parametrisation, mapped to texel centres.
fn transmittanceUv(r: f32, mu: f32, R: f32, Rt: f32) -> vec2f {
    let H = sqrt(max((Rt - R) * (Rt + R), 0.0));
    let rho = sqrt(max((r - R) * (r + R), 0.0));
    let disc = r * r * (mu * mu - 1.0) + Rt * Rt;
    let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
    let dMin = Rt - r;
    let dMax = rho + H;
    let xMu = saturate((d - dMin) / max(dMax - dMin, 1.0e-4));
    let xR = saturate(rho / H);
    return (vec2f(xMu, xR) * (TRANSMITTANCE_LUT_SIZE - 1.0) + 0.5) / TRANSMITTANCE_LUT_SIZE;
}

// Sun transmittance at radius r for cos(sun zenith) mu, including a soft planet shadow.
fn sunTransmittance(lut: texture_2d<f32>, samp: sampler, r: f32, mu: f32, R: f32, Rt: f32) -> vec3f {
    let rc = clamp(r, R, Rt);
    let t = textureSampleLevel(lut, samp, transmittanceUv(rc, mu, R, Rt), 0.0).rgb;
    let sinHorizon = R / rc;
    let muHorizon = -sqrt(max(0.0, 1.0 - sinHorizon * sinHorizon));
    // Penumbra width (atmoExtra.z): a hard planet shadow sweeps across the whole cloud deck as a
    // sharp front at dusk, fastest on a small planet.
    return t * smoothstep(-u.atmoExtra.z, u.atmoExtra.z, mu - muHorizon);
}

// Rows: 0 sky radiance at cloud altitude, 1 upwelling radiance at cloud altitude, 2 sky radiance at ground.
fn ambientUv(mu: f32, row: f32) -> vec2f {
    let x = saturate((mu - AMBIENT_MU_MIN) / (1.0 - AMBIENT_MU_MIN));
    return vec2f((x * (AMBIENT_LUT_WIDTH - 1.0) + 0.5) / AMBIENT_LUT_WIDTH, (row + 0.5) / AMBIENT_LUT_ROWS);
}
`;

// Cloud-shadow lookups for a compositor or ground shader.
// Requires: u: CloudUniforms, shadowMap: texture_2d<f32> (getOutputs().shadowView), linearSampler.
export const CLOUD_SHADOW_LOOKUP_WGSL = /* wgsl */`
// The map holds optical depth along the sun for rays starting on its plane, so p is projected
// onto the plane along the sun. The plane stays put while the sun moves, so the texel grid does
// not slide over the ground.
fn shadowMapUv(p: vec3f) -> vec2f {
    let n = cross(u.shadowE1.xyz, u.shadowE2.xyz);
    let sn = dot(u.sun.xyz, n);
    if (sn < 0.02) { return vec2f(-1.0); }
    let q = p - u.sun.xyz * ((dot(p, n) - u.shadowInfo.y) / sn);
    return vec2f(dot(q, u.shadowE1.xyz) - u.shadowE2.w, dot(q, u.shadowE2.xyz) - u.shadowInfo.x) / u.shadowE1.w + 0.5;
}

// Multiplier on the map's optical depth at p; 0 means unshadowed. Combines the caller's strength,
// the module's altitude fade (shadowInfo.z; the map is stale at 0), the map-edge fade, and, inside
// the layer, the fraction of the column above p.
fn cloudShadowScale(p: vec3f, uv: vec2f, strength: f32) -> f32 {
    let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let above = saturate((u.planet.z - length(p)) / (u.planet.z - u.planet.y));
    return u.density.x * strength * u.shadowInfo.z * above * smoothstep(0.0, 0.15, edge);
}

// Bilinear: cheap enough for every atmosphere step (god rays).
fn cloudShadowAt(p: vec3f, strength: f32) -> f32 {
    let uv = shadowMapUv(p);
    let k = cloudShadowScale(p, uv, strength);
    if (k <= 0.0) { return 1.0; }
    return exp(-textureSampleLevel(shadowMap, linearSampler, uv, 0.0).r * k);
}

// Cubic B-spline from four bilinear taps, for shadows on the ground. Bilinear optical depth
// put through exp() draws the texel grid as diamond-shaped shadow edges.
fn cloudShadowSmoothAt(p: vec3f, strength: f32) -> f32 {
    let uv = shadowMapUv(p);
    let k = cloudShadowScale(p, uv, strength);
    if (k <= 0.0) { return 1.0; }
    let size = vec2f(textureDimensions(shadowMap));
    let x = uv * size - 0.5;
    let i = floor(x);
    let f = x - i;
    let f2 = f * f;
    let f3 = f2 * f;
    let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let g0 = w0 + w1;
    let g1 = w2 + w3;
    let uv0 = (i - 0.5 + w1 / g0) / size;
    let uv1 = (i + 1.5 + w3 / g1) / size;
    let od = g0.y * (g0.x * textureSampleLevel(shadowMap, linearSampler, uv0, 0.0).r
                   + g1.x * textureSampleLevel(shadowMap, linearSampler, vec2f(uv1.x, uv0.y), 0.0).r)
           + g1.y * (g0.x * textureSampleLevel(shadowMap, linearSampler, vec2f(uv0.x, uv1.y), 0.0).r
                   + g1.x * textureSampleLevel(shadowMap, linearSampler, uv1, 0.0).r);
    return exp(-od * k);
}
`;

// Rotation matrix (axis-angle) as a WGSL constructor.
function rotationWgsl(axis, angle) {
    const l = Math.hypot(...axis);
    const [x, y, z] = axis.map(v => v / l);
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    const m = [
        t * x * x + c, t * x * y - s * z, t * x * z + s * y,
        t * x * y + s * z, t * y * y + c, t * y * z - s * x,
        t * x * z - s * y, t * y * z + s * x, t * z * z + c,
    ];
    return `mat3x3f(${m.map(v => v.toFixed(6)).join(', ')})`;
}

// The noise volumes tile along their axes. Sampled in world space they repeat on an exact square
// lattice wherever the surface is axis-aligned (the lab's start site faces +Y). Each lookup is
// rotated so the surface cuts the lattice obliquely; these angles leave no near-repeat closer than
// ~2.4 tiles at +Y, and the weather warps in sampleWeather break up the rest. Changing them reseeds
// every pattern.
export const CLOUD_LAYER_BLEND_WGSL = /* wgsl */`
struct MarchResult {
    color: vec4f,
    depth: f32,
}

fn blendCloudLayers(front: MarchResult, back: MarchResult) -> MarchResult {
    if (front.color.a >= 0.9999) { return back; }
    if (back.color.a >= 0.9999) { return front; }
    let T = front.color.a * back.color.a;
    let nearWeight = 1.0 - front.color.a;
    let farWeight = front.color.a * (1.0 - back.color.a);
    let depth = (nearWeight * front.depth + farWeight * back.depth) / max(1.0 - T, 1.0e-5);
    return MarchResult(vec4f(front.color.rgb + front.color.a * back.color.rgb, T), depth);
}
`;

// Shared by passes that trace the same cloud target, including its packed ray grid.
export const CLOUD_RAY_INPUT_WGSL = /* wgsl */`
// Distance (km) along rd to the nearest opaque surface under this cloud pixel, or 1e30 for sky.
// Nearest, so cloud behind a silhouette never bleeds onto it after upsampling; the cost is a
// sub-pixel gap in the clouds right along the silhouette.
fn sceneDistance(first: vec2u, last: vec2u, size: vec2u, rd: vec3f) -> f32 {
    if (u.sceneDepth.w < 0.5) { return 1.0e30; }
    let z = nearestSceneDepth(sceneDepth, first, last, size);
    if (z >= 1.0) { return 1.0e30; }
    // View depth from the [0, 1] perspective depth, then along the ray.
    let viewDepth = u.sceneDepth.y / (z + u.sceneDepth.x);
    return viewDepth * u.sceneDepth.z / max(-dot(rd, u.camBack.xyz), 1.0e-4);
}

struct CloudRay {
    direction: vec3f,
    sceneDistance: f32,
    pixel: vec2f,
}

fn cloudRay(id: vec2u) -> CloudRay {
    let size = vec2u(u.frameInfo.zw);
    var pixel = min(id * u32(u.quality.x) + vec2u(u.quality.yz), size - 1u);
    var last = pixel;
    let stride = u32(u.look4.z);
    if (stride >= 2u) {
        pixel = id * stride;
        last = min(pixel + stride - 1u, size - 1u);
    } else if (stride == 1u) {
        pixel.x = min(2u * id.x + (id.y & 1u), size.x - 1u);
        last = pixel;
    }
    let pix = (vec2f(pixel) + vec2f(last)) * 0.5 + 0.5;
    let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    return CloudRay(rd, sceneDistance(pixel, last, size, rd), pix);

}
`;

const NOISE_ROTATIONS_WGSL = /* wgsl */`
const ROT_SHAPE = ${rotationWgsl([-0.52, -0.31, 0.33], 1.02)};
const ROT_DETAIL = ${rotationWgsl([-0.79, -0.06, 0.39], 2.25)};
const ROT_SYSTEM = ${rotationWgsl([-0.95, 0.84, 0.02], 1.0)};
const ROT_REGIONAL = ${rotationWgsl([-0.8, -0.75, -0.05], 1.99)};
const ROT_LARGE = ${rotationWgsl([-0.02, -0.49, -0.69], 1.13)};
`;

// Requires: u: CloudUniforms, shapeTex, detailTex, weatherTex (texture_3d), noiseSampler.
export const CLOUD_DENSITY_WGSL = /* wgsl */`${NOISE_ROTATIONS_WGSL}
const SHAPE_TEXELS: f32 = 128.0;
const DETAIL_TEXELS: f32 = 64.0;
const WEATHER_TEXELS: f32 = 128.0;

// 0 retains live controls, 1 is cut, 2 is domes, 3 is domes with giants, 4 stretches domes.
override CLOUD_SHAPE: u32 = 0u;
override SKIP_UNUSED_DENSITY: bool = false;

fn usesDomes() -> bool {
    return CLOUD_SHAPE >= 2u || (CLOUD_SHAPE == 0u && u.march3.z > 0.5);
}

fn usesGiants() -> bool {
    return CLOUD_SHAPE == 3u || (CLOUD_SHAPE == 0u && u.shape2.x > 0.0);
}

fn stretchesDomes() -> bool {
    return CLOUD_SHAPE == 4u || (CLOUD_SHAPE == 0u && u.march4.z > 0.5);
}

struct CloudBase {
    density: f32,
    h: f32,
    warp: vec3f,
    skew: vec3f,
    variety: f32,   // 0..1 per cloud: picks billow size and erosion strength
    rise: vec3f,    // boil offset of the shape lookup, reused (faster) for detail
    localH: f32,    // 0 at this cloud's base .. 1 at its top (lighting: dark bases, billowy tops)
    stratiform: f32, // optically thick deck fraction, with less erosion than cumulus
}

struct Weather {
    coverage: f32,
    kind: f32,      // 0 stratus .. 1 towering cumulus
    lift: f32,      // base lift (layer fraction)
    stretch: f32,   // regional height multiplier weight for the tower preview
    shift: vec3f,   // shape-noise offset (tiles), varies over ~100 km so cloud cells never form a grid
}

fn heightFraction(r: f32) -> f32 {
    return (r - u.planet.y) / (u.planet.z - u.planet.y);
}

// Mip level for a weather lookup with tile frequency invTile (1/km). One level of extra blur:
// weather is smooth at heart, and from orbit an unfiltered lookup lets sub-pixel clouds pop in
// and out as the camera moves.
fn weatherLod(footprint: f32, invTile: f32) -> f32 {
    return max(0.0, log2(footprint * invTile * WEATHER_TEXELS) + 1.0);
}

fn sampleWeather(p: vec3f, footprint: f32) -> Weather {
    let up = normalize(p);
    // Wind slides the pattern; evolution moves the lookup off the sphere, through the noise
    // volume, so systems form and dissolve instead of only drifting.
    let q = up * (u.planet.y + u.lod.y) + u.windShape.xyz * 0.8;
    // Planet-scale systems (fronts, clear highs), domain-warped so they swirl.
    let sysP = ROT_SYSTEM * ((q - up * (u.lod.y * 0.7)) * u.systems.x) + vec3f(1.0, 0.37, 0.71) * u.systems.w;
    let warp = textureSampleLevel(weatherTex, noiseSampler, sysP * 0.61 + vec3f(0.47, 0.21, 0.83),
        weatherLod(footprint, u.systems.x * 0.61));
    let sys = textureSampleLevel(weatherTex, noiseSampler, sysP + (warp.rga - 0.5) * u.systems.z,
        weatherLod(footprint, u.systems.x));
    // Each octave is displaced by the next larger one, so copies of a tile land at irregular
    // spacings with different distortion instead of on a grid.
    let w2 = textureSampleLevel(weatherTex, noiseSampler,
        ROT_LARGE * (q * u.scales.w) + (warp.gba - 0.5) * 1.5 + vec3f(0.31, 0.57, 0.13), weatherLod(footprint, u.scales.w));
    let w1 = textureSampleLevel(weatherTex, noiseSampler, ROT_REGIONAL * (q * u.scales.z) + (w2.gbr - 0.5) * 1.0,
        weatherLod(footprint, u.scales.z));
    let regional = mix(w1.r, w1.b, 0.35) * 0.6 + w2.r * 0.4 + (w1.a - 0.5) * 0.2;
    let field = (sys.r - 0.5) * u.systems.y + (regional - 0.5);
    var weather: Weather;
    let scattered = saturate(u.coverage.x + field * u.coverage.y);
    weather.coverage = mix(scattered, max(scattered, 0.58), u.weatherStyle.y * 0.85) * u.weatherStyle.x;
    // Clusters of taller towers (Worley clumps, tens of km apart) among shallower fields.
    weather.kind = saturate(u.coverage.z + (w1.g * 0.5 + sys.g * 0.5 - 0.5) * u.coverage.w + (w1.b - 0.5) * 0.9);
    // Bases are flat per cloud but their height (the condensation level) drifts across regions by up
    // to a quarter of the layer, as it does with humidity in nature.
    weather.lift = saturate(w2.a * 1.6 - 0.5) * 0.25;
    if (stretchesDomes()) {
        // Already-fetched regional channels select whole cloud groups.
        weather.stretch = smoothstep(0.47, 0.65, 0.62 * sys.g + 0.38 * w2.r);
    }
    weather.shift = (vec3f(w1.g, w1.b, w2.a) - 0.5) * 1.2;
    // Shape offset mode (windDir.w): 0 as above, 1 slow, 2 none (test). The channels above vary over a
    // few km (w2.a is 8-64 cycles per large tile, w1.b Worley creases) while the offset spans +-0.6
    // shape tiles: where they change fast the offset outruns the shape noise's own rate (1/16 tile per
    // km) and squeezes or folds it sideways but not vertically, into thin vertical sheets through the
    // cloud that shimmer as they alias. Slow: the smooth Perlin channels of the planet-scale lookup at
    // mip 3 (~40 km texels), so the offset varies over 50-200 km as intended and never folds.
    if (u.windDir.w > 1.5) {
        weather.shift = vec3f(0.0);
    } else if (u.windDir.w > 0.5) {
        let slow = textureSampleLevel(weatherTex, noiseSampler, sysP * 0.83 + vec3f(0.29, 0.71, 0.13), 3.0);
        weather.shift = vec3f(slow.r - 0.5, slow.g - 0.5, (slow.r - slow.g) * 0.7) * 1.2;
    }
    return weather;
}

// Worley value (1 - distance to the nearest cell point) to a round head: sqrt(1 - d^2) over ~0.67 of
// the cell. The raw value is a cone around each point: as bumps it made peaks and ridges (rock), not
// the rounded heads with creases between them that cumulus are made of.
fn roundBump(w: f32) -> f32 {
    let d = 1.0 - w;
    return sqrt(saturate(1.0 - d * d * 2.2));
}

// Polynomial smooth minimum: rounds the crease where two surfaces meet (k in their units).
fn sminK(a: f32, b: f32, k: f32) -> f32 {
    let h = saturate(0.5 + 0.5 * (b - a) / k);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// Flat bases, rounded tops. Denser regions build taller towers.
fn profileRise(h: f32, kind: f32) -> f32 {
    return smoothstep(0.0, mix(0.04, 0.1, kind), h);
}

fn profileFall(h: f32, kind: f32, coverage: f32) -> f32 {
    let top = mix(0.2, 1.0, kind) * mix(0.55, 1.0, coverage);
    return 1.0 - smoothstep(top * mix(0.35, 0.55, kind), top, h);
}

fn heightProfile(h: f32, kind: f32, coverage: f32) -> f32 {
    return profileRise(h, kind) * profileFall(h, kind, coverage);
}

fn shapeSignal(n: vec4f) -> f32 {
    let fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    // Expand the useful part of the Perlin-Worley range so coverage can select it.
    return remap(remap(n.r, fbm - 1.0, 1.0, 0.0, 1.0), 0.5, 0.95, 0.0, 1.0);
}

fn broadShapeSignal(shapeP: vec3f) -> f32 {
    // This mip has ~1.4 km texels on the 8 km cumulus tile.
    return shapeSignal(textureSampleLevel(shapeTex, noiseSampler, shapeP, 4.5));
}

// Altocumulus has broad neighbouring cells that join into broken sheets.
// Sample horizontally across that layer and build a shallow volume with a
// varying base and top. The thickness still matters when flying through it.
fn altoDensity(p: vec3f, r: f32, weather: Weather, footprint: f32) -> f32 {
    if (u.alto.x <= 0.0 || r <= u.alto.y || r >= u.alto.z || weather.coverage <= 0.04) { return 0.0; }
    let up = p / r;
    let deck = up * (u.alto.y + 0.3 * (r - u.alto.y));
    let flow = u.windShape.xyz * 1.28;
    let q = ROT_SYSTEM * ((deck + flow) * u.alto.w) + weather.shift * 0.35 + vec3f(0.36, 0.62, 0.12);
    let lod = max(0.0, log2(footprint * u.alto.w * SHAPE_TEXELS));
    let n = textureSampleLevel(shapeTex, noiseSampler, q, lod);
    let humid = smoothstep(0.04, 0.43, weather.coverage);
    let shoulder = shapeSignal(n) - mix(1.02, 0.67, humid);
    if (shoulder < -0.12) { return 0.0; }
    // A second octave breaks each sheet into lobes of different thickness.
    // Its short wavelengths fall away with distance; the main cloud remains.
    let detailP = ROT_DETAIL * ((mix(deck, p, 0.35) + flow) * (u.alto.w * 3.4)) + n.gba * 0.21;
    let detail = textureSampleLevel(shapeTex, noiseSampler, detailP, max(0.0, lod + 1.75));
    let breakup = 0.39 * (detail.r - 0.64) + 0.13 * (detail.b - 0.6) + 0.18 * (n.a - 0.6);
    let core = smoothstep(0.0, 0.17, shoulder + breakup);
    let h = (r - u.alto.y) / (u.alto.z - u.alto.y);
    let base = 0.18 + 0.17 * n.b + 0.14 * (detail.g - 0.5);
    let top = base + mix(0.19, 0.53, core) * mix(0.65, 1.0, detail.g);
    let profile = smoothstep(base - 0.10, base, h) * (1.0 - smoothstep(top - 0.12, top, h));
    return 0.095 * u.alto.x * core * core * profile * humid;
}

// Weather is height-invariant and smooth, so callers may reuse one sample for nearby points.
fn cumulusBase(p: vec3f, h: f32, weather: Weather, footprint: f32) -> CloudBase {
    var b: CloudBase;
    b.density = 0.0;
    b.h = h;
    if (h <= 0.0 || h >= 1.0 || weather.coverage <= 0.001) { return b; }
    let hRel = (b.h - weather.lift) / (1.0 - weather.lift);
    let profile = heightProfile(hRel, weather.kind, weather.coverage);
    // Domes (march3.z > 0, its value the height scale; see below) reach higher than the cut profile:
    // its early-out sliced them flat at the cut profile's top.
    let domes = usesDomes();
    // Popcorn tops: shape2.w is the popcorn height as a fraction of the layer (host sets it in km), so a
    // thick layer for towering giants does not make every small cloud tall too.
    var smallTop = u.shape2.w * mix(0.6, 1.4, weather.kind) * mix(0.75, 1.0, weather.coverage) * u.march3.z;
    if (stretchesDomes()) { smallTop *= 1.0 + 3.9 * weather.stretch; }
    smallTop = min(0.92, smallTop);
    let domeTop = select(smallTop, 0.92, usesGiants());
    if (select(profile <= 0.0, hRel <= 0.0 || hRel >= domeTop, domes)) { return b; }
    b.skew = u.windDir.xyz * (b.h * u.windDetail.w);
    let lod = max(0.0, log2(footprint * u.scales.x * SHAPE_TEXELS));
    // Shapes rise through the layer over time (sampled lower and lower), so cumulus slowly boil.
    let rise = normalize(p) * u.lod.z;
    // Domes: the shape varies 1.18x slower with height than across (1.6x stretched tower heads into vertical rock-like ribs), so a cloud stays one connected column
    // from base to top (at the same rate, strong patches at mid height floated as separate balls).
    let upN = normalize(p);
    var squeeze = 0.15;
    if (stretchesDomes()) { squeeze += 0.46 * weather.stretch; }
    let pS = select(p, p - upN * ((length(p) - u.planet.y) * squeeze), domes);
    let shapeP = ROT_SHAPE * ((pS + u.windShape.xyz + b.skew - rise) * u.scales.x) + weather.shift;
    let n = textureSampleLevel(shapeTex, noiseSampler, shapeP, lod);
    let raw = shapeSignal(n);
    b.warp = n.gba - 0.5;
    b.rise = rise;
    // Varies over the 1-4 km Worley cells, so neighbouring clouds get different billows.
    b.variety = smoothstep(0.35, 0.75, n.g * 0.5 + n.a * 0.5);
    if (domes) {
        // Domes: coverage picks where clouds stand from the shape alone, then the top part of the
        // height profile erodes them from above, so only dense cores reach high and each cloud's
        // height follows its core: rounded tops of varied height. The base stays a flat cut (rise).
        // Multiplying the shape by the profile before the high coverage threshold (0.72-0.92) kept
        // only heights where the profile is ~1: flat tops at one height and vertical sides (mesas).
        // Height follows the unclamped shape (peaks keep varying; the clamped one had flat plateaus at
        // 1, and every column on a plateau rose to the same height: flat tops again). core is 0 at the
        // cloud's edge and up to ~1.6 at the strongest peaks.
        // Cauliflower heads (look2.y): round 1 km and 0.5 km cells of the shape noise (already fetched)
        // raise the core around their centres and sink it between them, so the surface is made of heads
        // with creases between, each lit on its sun side. Without them the body between the km-scale shape
        // and the fine detail was smooth and evenly shaded (cotton balls).
        // Centred near roundBump's mean (~0.72) so the heads reshape clouds without adding coverage.
        // Heads only reshape existing cloud: added in clear air, every round cell near a cloud became a
        // tiny blob that the detail erosion shredded into specks of dust around the clouds.
        var smallThreshold = 1.0 - weather.coverage;
        let suppression = u.look5.y;
        var broad = 0.0;
        let sampledBroad = suppression > 0.0 && raw > smallThreshold;
        if (sampledBroad) {
            // Fine peaks outside broader masses need a stronger core to form a cloud.
            // The fixed world-space lookup keeps this test independent of the view footprint.
            broad = broadShapeSignal(shapeP);
            smallThreshold += 0.75 * suppression * (1.0 - smoothstep(0.68, 0.94, broad));
        }
        let coreRaw = max(raw - smallThreshold, 0.0) / max(weather.coverage, 0.01);
        b.localH = saturate(hRel / max(smallTop, 0.01));
        // An empty cumulus sample can still have a sheet cloud on top of it.
        // Keep its detail coordinates for that layer, and skip the dome profile.
        if (SKIP_UNUSED_DENSITY && !usesGiants() && coreRaw == 0.0) { return b; }
        let heads = ((roundBump(n.b) - 0.72) * 0.6 + (roundBump(n.a) - 0.72) * 0.4) * u.look2.y;
        let core = coreRaw + heads * smoothstep(0.0, 0.25, coreRaw);
        // Popcorn: rounded heads up to smallTop. Weak cores are also eroded from below, so small clouds
        // float a little higher with rounded undersides while big ones keep the flat base at the
        // condensation level (one flat cut for every cloud looked uniform).
        // Concave ramp: weak cores stop low, so small clouds come out wider than tall (humilis) and only
        // strong ones build into heads. The base lift is small: lifted far (0.35 of the top), weak clouds
        // got rounded undersides and floated as balls.
        let erodeTop = 2.0 * pow(smoothstep(smallTop * mix(0.15, 0.3, weather.kind), smallTop, hRel), 0.7);
        let erodeBase = 0.3 * (1.0 - smoothstep(0.0, smallTop * 0.12, hRel));
        // Edge sharpness (look2.x): the core rises slowly across a cloud (km-scale noise), so without it the
        // density ramped up over hundreds of metres and the edge was a soft fog (blurry, solid-looking
        // blobs). Cumulus edges are abrupt; the detail erosion then carves billows into that edge.
        var d = saturate((core - erodeTop - erodeBase) * u.look2.x);
        // Giants (shape2.x share of the coverage; 0 = off): the shape noise at shape2.z times the tile, in
        // its own rotation, so a few cells grow several times wider, with cores scaled by shape2.y so they
        // tower up to the layer top (height grows with size, as in nature). The core is bumped by the
        // popcorn-scale shape, so a giant's outline is made of heads the size of whole small clouds
        // (cauliflower), with the detail billows on top of those.
        if (usesGiants()) {
            let invG = u.scales.x / max(u.shape2.z, 1.0);
            let pG = ROT_REGIONAL * ((p + u.windShape.xyz + b.skew - rise) * invG) + weather.shift * 0.5
                + vec3f(0.37, 0.11, 0.53);
            let nG = textureSampleLevel(shapeTex, noiseSampler, pG, max(0.0, log2(footprint * invG * SHAPE_TEXELS)));
            let rawG = shapeSignal(nG);
            let cG = max(weather.coverage * u.shape2.x, 0.005);
            // 0 at the giant's edge, 1 at its strongest core.
            let coreG = saturate((rawG - (1.0 - cG)) / cG / 1.6);
            // The giant cell is a local weather map (as in Nubis): inside it the coverage of the popcorn
            // shape noise rises toward 0.9, so the giant is built from that 3D billowy noise itself: its
            // outline is whole 1-2 km noise cells (heads on heads), not a surface with bumps on it.
            // Earlier versions shaped the giant as a heightfield envelope plus bumps, and it read as a
            // mountain or rock with snow on it.
            let maskG = smoothstep(0.0, 0.45, coreG);
            let covL = mix(weather.coverage, 0.9, maskG);
            let coreLRaw = max(raw - (1.0 - covL), 0.0) / max(covL, 0.01);
            let coreL = coreLRaw + heads * smoothstep(0.0, 0.25, coreLRaw);
            // Tower height grows with the mask (wider part of the giant = taller), scaled by shape2.y / 3.
            let topG = 0.08 + 0.82 * maskG * (0.8 + 0.2 * coreG) * min(u.shape2.y / 3.0, 1.0);
            // Erosion by height, held back until ~60 % of the tower (a massive column) and rising fast
            // above, so only the strongest noise cores reach the top: big rounded billowy heads, and the
            // base cut flat at the condensation level. (Eroding from 20 % up thinned towers into spires.)
            let erodeG = 1.4 * pow(smoothstep(topG * 0.3, topG, hRel), 1.6)
                + 0.3 * (1.0 - smoothstep(0.0, 0.025, hRel));
            // The giant fades out at its rim by erosion (shapes shrink), not by scaling density down: a
            // scaled fringe was a wide faint layer that the detail erosion shredded into specks of dust.
            var margin = (1.0 - maskG) * 1.2;
            if (suppression > 0.0 && maskG < 0.9 && coreL - erodeG > margin) {
                if (!sampledBroad) { broad = broadShapeSignal(shapeP); }
                let unsupported = 1.0 - smoothstep(0.57, 0.87, broad);
                let rim = 1.0 - smoothstep(0.25, 0.9, maskG);
                margin += 0.64 * suppression * unsupported * rim;
            }
            let dG = saturate((coreL - erodeG - margin) * u.look2.x);
            if (dG > d) { b.localH = saturate(hRel / max(topG, 0.01)); }
            d = max(d, dG);
        }
        // Interior variation (look5.x): density thins between the 1 and 2 km Worley cells (the puffs), after
        // the edge gain saturated the body to a uniform 1. Gives see-through pockets and ragged, ethereal
        // regions inside clouds instead of an evenly opaque mass.
        let pockets = smoothstep(0.3, 0.75, n.g * 0.55 + n.b * 0.45);
        d *= mix(1.0, pockets * pockets, u.look5.x);
        b.density = d * smoothstep(0.0, max(smallTop * 0.08, 0.005), hRel) * mix(0.6, 1.0, weather.coverage);
    } else {
        let shape = saturate(raw) * profile;
        b.localH = saturate(hRel / max(mix(0.2, 1.0, weather.kind) * mix(0.55, 1.0, weather.coverage), 0.01));
        // Coverage decides where clouds exist; small fair-weather clouds stay dense.
        b.density = remapSat(shape, 1.0 - weather.coverage, 1.0, 0.0, 1.0) * mix(0.6, 1.0, weather.coverage);
    }
    return b;
}

// Sheet clouds fill the gaps between cumulus as moist weather gathers. Their
// nearly continuous bases lower as the layer thickens toward rain.
fn deckHeight(h: f32, weather: Weather) -> f32 {
    let base = mix(0.16, 0.035, u.weatherStyle.z) + 0.32 * weather.lift;
    let depth = mix(0.24, 0.49, u.weatherStyle.z);
    return (h - base) / depth;
}

fn cloudBaseWithWeather(p: vec3f, h: f32, weather: Weather, footprint: f32) -> CloudBase {
    var b = cumulusBase(p, h, weather, footprint);
    if (u.weatherStyle.y <= 0.001 || weather.coverage <= 0.001) { return b; }
    b.density *= 1.0 - 0.78 * u.weatherStyle.y;
    let deckH = deckHeight(h, weather);
    if (deckH <= 0.0 || deckH >= 1.0) { return b; }
    let up = normalize(p);
    let q = ROT_LARGE * ((up * u.planet.y + up * (length(p) - u.planet.y) * 0.32 + u.windShape.xyz) / 22.0)
        + weather.shift * 0.3;
    let n = textureSampleLevel(shapeTex, noiseSampler, q, max(0.0, log2(footprint * SHAPE_TEXELS / 22.0)));
    let humidity = smoothstep(0.10, 0.56, weather.coverage);
    let core = smoothstep(mix(0.83, 0.51, humidity), mix(1.03, 0.81, humidity), shapeSignal(n));
    let top = mix(0.48, 1.0, core);
    let profile = smoothstep(0.0, 0.15, deckH) * (1.0 - smoothstep(top * 0.52, top, deckH));
    let deck = core * profile * u.weatherStyle.y * mix(0.30, 0.53, u.weatherStyle.z);
    let total = b.density + deck;
    b.density = saturate(total);
    b.stratiform = deck / max(total, 1.0e-5);
    b.localH = mix(b.localH, saturate(deckH / top), b.stratiform);
    return b;
}

fn lowStratusDensity(p: vec3f, r: f32, weather: Weather, footprint: f32) -> f32 {
    if (u.weatherStyle.w <= 0.001 || r <= u.lowCloud.x || r >= u.lowCloud.y) { return 0.0; }
    let up = p / r;
    let h = (r - u.lowCloud.x) / (u.lowCloud.y - u.lowCloud.x);
    let flow = u.windShape.xyz * 0.58;
    let q = ROT_REGIONAL * ((up * u.lowCloud.x + up * (r - u.lowCloud.x) * 0.46 + flow) * u.lowCloud.z)
        + weather.shift * 0.5 + vec3f(0.2, 0.44, 0.67);
    let n = textureSampleLevel(shapeTex, noiseSampler, q, max(0.0, log2(footprint * u.lowCloud.z * SHAPE_TEXELS)));
    let humid = smoothstep(0.12, 0.51, weather.coverage + u.weatherStyle.w * 0.22);
    let base = mix(0.05, 0.34, n.b);
    let top = mix(0.54, 0.98, n.g) + 0.06 * (n.a - 0.64);
    let profile = smoothstep(base, base + 0.17, h) * (1.0 - smoothstep(top - 0.25, top, h));
    let coverage = smoothstep(mix(0.95, 0.70, humid), mix(1.09, 0.89, humid), shapeSignal(n) + 0.26 * (n.a - 0.62));
    return 0.16 * coverage * profile * u.weatherStyle.w;
}

// Erode the base shape with high-frequency Worley: wispy bottoms, billowy tops.
// One detail tile is only ~1 km, so on its own it prints equal bubbles on a lattice across a
// whole deck. The shape noise warps it by up to about a tile, and each cloud mixes its own
// billow size and erosion strength.
fn cloudDetail(p: vec3f, b: CloudBase, footprint: f32) -> f32 {
    let lod = max(0.0, log2(footprint * u.scales.y * DETAIL_TEXELS));
    // Domes: fade the erosion out once its cells are a few pixels wide (lod: one mip per doubling of the
    // footprint over a detail texel). Thresholding sub-pixel detail cut far clouds' thin fringes into
    // single-pixel islands (dust); their silhouettes come from the base shape at that distance anyway.
    let far = select(1.0, 1.0 - smoothstep(2.5, 4.5, lod), usesDomes());
    var cut = 0.0;
    if (!SKIP_UNUSED_DENSITY || (far > 0.0 && u.density.y != 0.0)) {
        let dp = ROT_DETAIL * ((p + u.windDetail.xyz + b.skew - b.rise * 1.5) * u.scales.y) + b.warp * u.density.z;
        let dn = textureSampleLevel(detailTex, noiseSampler, dp, lod).rgb;
        let large = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
        let small = dn.g * 0.6 + dn.b * 0.4;
        let fbm = mix(large, small, b.variety);
        let billow = 1.0 - mix(roundBump(dn.g), roundBump(dn.b), b.variety * 0.6 + 0.2);
        // Round the interior while retaining the wispy erosion on the outside.
        var wispyToBillow = select(saturate(b.h * 6.0), saturate(b.localH * 4.0), usesDomes());
        wispyToBillow *= mix(1.0, smoothstep(0.05, 0.5, b.density), u.look4.w);
        let modifier = mix(fbm, billow, wispyToBillow);
        cut = modifier * u.density.y * mix(0.6, 1.15, b.variety) * far * mix(1.0, 0.32, b.stratiform);
    }
    let delta = b.density - cut;
    // Smooth the hard erosion threshold only within the thin edge. This leaves the
    // dense interior intact and lets fragments fade into transparent wisps.
    let width = u.extra.x * smoothstep(0.0, 0.08, b.density);
    let fringe = max(width - abs(delta), 0.0);
    let softened = max(delta, 0.0) + fringe * fringe / max(4.0 * width, 1.0e-5);
    let density = saturate(softened / max(1.0 - cut, 1.0e-5));
    return density * mix(0.55, 1.0, smoothstep(0.0, 5.0 * u.extra.x, density));
}

struct DeckColumn {
    floorSq: f32,
    roofSq: f32,
    density: f32,
}

// Filter the whole weather bank in planet-relative space before tracing its thickness.
fn deckColumn(p: vec3f, footprint: f32) -> DeckColumn {
    let q = ROT_SYSTEM * ((normalize(p) * u.planet.y + u.windShape.xyz * 0.6) / 34.0);
    let lod = max(0.0, log2(max(footprint, 0.65) * SHAPE_TEXELS / 34.0));
    let n = textureSampleLevel(shapeTex, noiseSampler, q, lod);
    let coverage = mix(u.coverage.x, max(0.58, u.coverage.x), u.weatherStyle.y);
    let moisture = smoothstep(0.06, 0.52, coverage);
    let signal = shapeSignal(n) + 0.16 * (n.b - 0.6);
    let cover = smoothstep(mix(0.94, 0.58, moisture), mix(1.10, 0.78, moisture), signal);
    let thickness = min(3.7, u.planet.z - u.planet.y);
    let roof = u.planet.y + thickness * (0.27 + 0.60 * cover * mix(0.56, 1.0, n.g));
    let floorR = u.planet.y + thickness * (0.05 + 0.16 * n.a);
    return DeckColumn(floorR * floorR, roof * roof, 0.13 * cover * mix(0.55, 1.0, moisture));
}

fn budgetBankThickness() -> f32 {
    return min(u.planet.z - u.planet.y, mix(1.9, 3.7, smoothstep(0.25, 0.9, u.weatherStyle.y)));
}

fn budgetBankColumn(p: vec3f, footprint: f32) -> DeckColumn {
    let wet = smoothstep(0.25, 0.9, u.weatherStyle.y);
    if (wet >= 1.0) { return deckColumn(p, footprint); }
    let up = normalize(p);
    let tile = mix(17.0, 34.0, wet);
    let q = ROT_SYSTEM * ((up * u.planet.y + u.windShape.xyz * 0.75) / tile);
    let lod = max(0.0, log2(max(footprint, 0.80) * SHAPE_TEXELS / tile));
    let n = textureSampleLevel(shapeTex, noiseSampler, q, lod);
    let moisture = smoothstep(0.045, 0.56, mix(u.coverage.x, max(0.58, u.coverage.x), wet));
    let signal = shapeSignal(n) + 0.18 * (n.b - 0.5);
    let cover = smoothstep(mix(0.90, 0.52, moisture), mix(1.07, 0.78, moisture), signal);
    let span = budgetBankThickness();
    let floorR = u.planet.y + span * mix(0.07, 0.16, n.a);
    let roof = floorR + span * mix(0.16, 0.73, sqrt(cover)) * mix(0.75, 1.0, n.g);
    let bank = DeckColumn(floorR * floorR, roof * roof, 0.12 * cover * mix(0.55, 1.0, moisture));
    if (wet <= 0.0) { return bank; }
    let deck = deckColumn(p, footprint);
    return DeckColumn(mix(bank.floorSq, deck.floorSq, wet), mix(bank.roofSq, deck.roofSq, wet),
        mix(bank.density, deck.density, wet));
}

fn columnDensity(radiusSq: f32, column: DeckColumn) -> f32 {
    let h = saturate((radiusSq - column.floorSq) / (column.roofSq - column.floorSq));
    return column.density * (4.0 * h * (1.0 - h));
}

fn deckExperimentDensity(p: vec3f, footprint: f32) -> f32 {
    let rSq = dot(p, p);
    let limit = min(u.planet.z, u.planet.y + 3.7);
    if (rSq <= u.planet.y * u.planet.y || rSq >= limit * limit) { return 0.0; }
    return columnDensity(rSq, deckColumn(p, footprint));
}

fn cloudDensity(p: vec3f, footprint: f32, withDetail: bool) -> f32 {
    let r = length(p);
    let h = heightFraction(r);
    let inLowLayer = u.weatherStyle.w > 0.001 && r > u.lowCloud.x && r < u.lowCloud.y;
    if (h >= 1.0 || (h <= 0.0 && !inLowLayer)) { return 0.0; }
    if (h > 0.0 && u.budget.w > 0.5) {
        // The bank column profile is zero past the top of both blended layers.
        // Keep the shadow integration grid and skip only guaranteed zero taps.
        let bankTop = u.planet.y + budgetBankThickness();
        let deckTop = min(u.planet.z, u.planet.y + 3.7);
        let top = select(bankTop, max(bankTop, deckTop), u.weatherStyle.y > 0.25);
        if (r > top) { return 0.0; }
        return columnDensity(r * r, budgetBankColumn(p, footprint));
    }
    if (h > 0.0 && u.march4.w > 0.5) { return deckExperimentDensity(p, footprint); }
    let weather = sampleWeather(p, footprint);
    if (h <= 0.0) { return lowStratusDensity(p, r, weather, footprint); }
    let b = cloudBaseWithWeather(p, h, weather, footprint);
    var density = b.density;
    if (withDetail && density > 0.0) { density = cloudDetail(p, b, footprint); }
    return density + altoDensity(p, r, weather, footprint);
}
`;
