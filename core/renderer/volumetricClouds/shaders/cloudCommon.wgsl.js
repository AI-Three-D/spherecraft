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
    shadowInfo: vec4f,  // x centre along e2, y plane offset along its normal, z shadow fade (0 = off, map not updated)
    windDir: vec4f,     // xyz unit wind direction
    systems: vec4f,     // x 1/weather-system tile, y system strength, z system warp, w pattern offset
    quality: vec4f,     // x interleave factor, yz this frame's interleave offset, w light steps
    lod: vec4f,         // x far-proxy weight (0 raymarch .. 1 slab proxy), y weather evolution (km), z boil rise (km), w history clip (sigmas)
    atmoRayleigh: vec4f, // xyz Rayleigh scattering (1/km), w Rayleigh scale height (km)
    atmoMie: vec4f,     // x Mie scattering, y Mie extinction (1/km), z Mie scale height (km), w Mie g
    atmoOzone: vec4f,   // xyz ozone absorption (1/km), w ozone peak altitude (km)
    atmoExtra: vec4f,   // x ozone half width (km), y ground albedo, z twilight softness (cos of sun angle), w 1 = no temporal (spatial filter)
    sceneDepth: vec4f,  // x projection[10], y projection[14], z km per depth unit, w 1 when a scene depth is bound
    ambientFloor: vec4f, // rgb radiance added to cloud ambient (night sky, moon); host supplied. w step footprint factor
    extra: vec4f,       // x 1 = refine cloud entry surfaces, yz far-average footprint range (km, z 0 = off), w far-average density scale
    moon: vec4f,        // xyz direction to the moon, w illuminance (0 = no moonlight)
}
`;

export const CLOUD_UNIFORM_VEC4_COUNT = 35;

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

struct CloudBase {
    density: f32,
    h: f32,
    warp: vec3f,
    skew: vec3f,
    variety: f32,   // 0..1 per cloud: picks billow size and erosion strength
    rise: vec3f,    // boil offset of the shape lookup, reused (faster) for detail
}

struct Weather {
    coverage: f32,
    kind: f32,      // 0 stratus .. 1 towering cumulus
    lift: f32,      // base lift (layer fraction)
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
    weather.coverage = saturate(u.coverage.x + field * u.coverage.y);
    // Clusters of taller towers (Worley clumps, tens of km apart) among shallower fields.
    weather.kind = saturate(u.coverage.z + (w1.g * 0.5 + sys.g * 0.5 - 0.5) * u.coverage.w + (w1.b - 0.5) * 0.9);
    // Bases are flat per cloud but their height (the condensation level) drifts across regions by up
    // to a quarter of the layer, as it does with humidity in nature.
    weather.lift = saturate(w2.a * 1.6 - 0.5) * 0.25;
    weather.shift = (vec3f(w1.g, w1.b, w2.a) - 0.5) * 1.2;
    return weather;
}

// Flat bases, rounded tops. Denser regions build taller towers.
fn heightProfile(h: f32, kind: f32, coverage: f32) -> f32 {
    let top = mix(0.2, 1.0, kind) * mix(0.55, 1.0, coverage);
    let rise = smoothstep(0.0, mix(0.04, 0.1, kind), h);
    let fall = 1.0 - smoothstep(top * mix(0.35, 0.55, kind), top, h);
    return rise * fall;
}

// Weather is height-invariant and smooth, so callers may reuse one sample for nearby points.
fn cloudBaseWithWeather(p: vec3f, h: f32, weather: Weather, footprint: f32) -> CloudBase {
    var b: CloudBase;
    b.density = 0.0;
    b.h = h;
    if (h <= 0.0 || h >= 1.0 || weather.coverage <= 0.001) { return b; }
    let profile = heightProfile((b.h - weather.lift) / (1.0 - weather.lift), weather.kind, weather.coverage);
    if (profile <= 0.0) { return b; }
    b.skew = u.windDir.xyz * (b.h * u.windDetail.w);
    let lod = max(0.0, log2(footprint * u.scales.x * SHAPE_TEXELS));
    // Shapes rise through the layer over time (sampled lower and lower), so cumulus slowly boil.
    let rise = normalize(p) * u.lod.z;
    let shapeP = ROT_SHAPE * ((p + u.windShape.xyz + b.skew - rise) * u.scales.x) + weather.shift;
    let n = textureSampleLevel(shapeTex, noiseSampler, shapeP, lod);
    let lowFbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    // Perlin-Worley eroded by low-frequency Worley lands in ~[0.45, 0.95]; stretch it to
    // ~[0, 1] so coverage maps to a proportional cloud fraction instead of an on/off switch.
    let shape = remapSat(remap(n.r, lowFbm - 1.0, 1.0, 0.0, 1.0), 0.5, 0.95, 0.0, 1.0) * profile;
    // Coverage decides where clouds exist; small fair-weather clouds stay dense.
    b.density = remapSat(shape, 1.0 - weather.coverage, 1.0, 0.0, 1.0) * mix(0.6, 1.0, weather.coverage);
    b.warp = n.gba - 0.5;
    b.rise = rise;
    // Varies over the 1-4 km Worley cells, so neighbouring clouds get different billows.
    b.variety = smoothstep(0.35, 0.75, n.g * 0.5 + n.a * 0.5);
    return b;
}

fn cloudBase(p: vec3f, footprint: f32) -> CloudBase {
    let h = heightFraction(length(p));
    if (h <= 0.0 || h >= 1.0) {
        var outside: CloudBase;
        outside.h = h;
        return outside;
    }
    return cloudBaseWithWeather(p, h, sampleWeather(p, footprint), footprint);
}

// Erode the base shape with high-frequency Worley: wispy bottoms, billowy tops.
// One detail tile is only ~1 km, so on its own it prints equal bubbles on a lattice across a
// whole deck. The shape noise warps it by up to about a tile, and each cloud mixes its own
// billow size and erosion strength.
fn cloudDetail(p: vec3f, b: CloudBase, footprint: f32) -> f32 {
    let lod = max(0.0, log2(footprint * u.scales.y * DETAIL_TEXELS));
    let dp = ROT_DETAIL * ((p + u.windDetail.xyz + b.skew - b.rise * 1.5) * u.scales.y) + b.warp * u.density.z;
    let dn = textureSampleLevel(detailTex, noiseSampler, dp, lod).rgb;
    let large = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    let small = dn.g * 0.6 + dn.b * 0.4;
    let fbm = mix(large, small, b.variety);
    let modifier = mix(fbm, 1.0 - fbm, saturate(b.h * 6.0));
    return remapSat(b.density, modifier * u.density.y * mix(0.6, 1.15, b.variety), 1.0, 0.0, 1.0);
}

fn cloudDensity(p: vec3f, footprint: f32, withDetail: bool) -> f32 {
    let b = cloudBase(p, footprint);
    if (!withDetail || b.density <= 0.0) { return b.density; }
    return cloudDetail(p, b, footprint);
}
`;
