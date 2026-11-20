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
    extra: vec4f,       // x 1 = refine cloud entry surfaces, yz far-average footprint range (km, z 0 = off), w far-average density scale
    moon: vec4f,        // xyz direction to the moon, w illuminance (0 = no moonlight)
    march3: vec4f,      // x light sharing (cloud samples per lighting evaluation; 1 = every sample), y longest reuse along the ray (km), z cloud shape (0 cut, > 0 domes of that height scale), w sunset depth (transmittance LUT; 1 = physical)
    shape2: vec4f,      // x giant share of coverage (0 = off), y giant height (core scale), z giant size (x shape tile), w popcorn top (layer fraction)
    look: vec4f,        // x in-scattering probability strength (HZD; 0 = off), y sideways sky occlusion (0 = off), z in-scattering gain, w sunlight-colour altitude scale (1 = physical)
    look2: vec4f,       // x dome edge sharpness (density gain), y cauliflower head strength, z dusk sky-light boost, w 1 = stratified step phases (no-temporal mode)
    look3: vec4f,       // x step-plane anchor lattice (km; 0 = planet centre), y detail pixel-footprint factor (0 = off), z/w profiling: old light weather + cutoff / old ungated heads
    look4: vec4f,       // x weather reuse distance along the ray (km; 0 = off), y detail transmittance cutoff (0 = always), zw unused
}
`;

export const CLOUD_UNIFORM_VEC4_COUNT = 41;

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
    localH: f32,    // 0 at this cloud's base .. 1 at its top (lighting: dark bases, billowy tops)
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

// Weather is height-invariant and smooth, so callers may reuse one sample for nearby points.
fn cloudBaseWithWeather(p: vec3f, h: f32, weather: Weather, footprint: f32) -> CloudBase {
    var b: CloudBase;
    b.density = 0.0;
    b.h = h;
    if (h <= 0.0 || h >= 1.0 || weather.coverage <= 0.001) { return b; }
    let hRel = (b.h - weather.lift) / (1.0 - weather.lift);
    let profile = heightProfile(hRel, weather.kind, weather.coverage);
    // Domes (march3.z > 0, its value the height scale; see below) reach higher than the cut profile:
    // its early-out sliced them flat at the cut profile's top.
    let domes = u.march3.z > 0.5;
    // Popcorn tops: shape2.w is the popcorn height as a fraction of the layer (host sets it in km), so a
    // thick layer for towering giants does not make every small cloud tall too.
    let smallTop = min(0.92, u.shape2.w * mix(0.6, 1.4, weather.kind) * mix(0.75, 1.0, weather.coverage) * u.march3.z);
    let domeTop = select(smallTop, 0.92, u.shape2.x > 0.0);
    if (select(profile <= 0.0, hRel <= 0.0 || hRel >= domeTop, domes)) { return b; }
    b.skew = u.windDir.xyz * (b.h * u.windDetail.w);
    let lod = max(0.0, log2(footprint * u.scales.x * SHAPE_TEXELS));
    // Shapes rise through the layer over time (sampled lower and lower), so cumulus slowly boil.
    let rise = normalize(p) * u.lod.z;
    // Domes: the shape varies 1.18x slower with height than across (1.6x stretched tower heads into vertical rock-like ribs), so a cloud stays one connected column
    // from base to top (at the same rate, strong patches at mid height floated as separate balls).
    let upN = normalize(p);
    let pS = select(p, p - upN * ((length(p) - u.planet.y) * 0.15), u.march3.z > 0.5);
    let shapeP = ROT_SHAPE * ((pS + u.windShape.xyz + b.skew - rise) * u.scales.x) + weather.shift;
    let n = textureSampleLevel(shapeTex, noiseSampler, shapeP, lod);
    let lowFbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    // Perlin-Worley eroded by low-frequency Worley lands in ~[0.45, 0.95]; stretch it to
    // ~[0, 1] so coverage maps to a proportional cloud fraction instead of an on/off switch.
    let raw = remapSat(remap(n.r, lowFbm - 1.0, 1.0, 0.0, 1.0), 0.5, 0.95, 0.0, 1.0);
    if (domes) {
        // Domes: coverage picks where clouds stand from the shape alone, then the top part of the
        // height profile erodes them from above, so only dense cores reach high and each cloud's
        // height follows its core: rounded tops of varied height. The base stays a flat cut (rise).
        // Multiplying the shape by the profile before the high coverage threshold (0.72-0.92) kept
        // only heights where the profile is ~1: flat tops at one height and vertical sides (mesas).
        // Height follows the unclamped shape (peaks keep varying; the clamped one had flat plateaus at
        // 1, and every column on a plateau rose to the same height: flat tops again). core is 0 at the
        // cloud's edge and up to ~1.6 at the strongest peaks.
        let rawU = remap(remap(n.r, lowFbm - 1.0, 1.0, 0.0, 1.0), 0.5, 0.95, 0.0, 1.0);
        // Cauliflower heads (look2.y): round 1 km and 0.5 km cells of the shape noise (already fetched)
        // raise the core around their centres and sink it between them, so the surface is made of heads
        // with creases between, each lit on its sun side. Without them the body between the km-scale shape
        // and the fine detail was smooth and evenly shaded (cotton balls).
        // Centred near roundBump's mean (~0.72) so the heads reshape clouds without adding coverage.
        let heads = ((roundBump(n.b) - 0.72) * 0.6 + (roundBump(n.a) - 0.72) * 0.4) * u.look2.y;
        // Heads only reshape existing cloud: added in clear air, every round cell near a cloud became a
        // tiny blob that the detail erosion shredded into specks of dust around the clouds.
        let coreRaw = max(rawU - (1.0 - weather.coverage), 0.0) / max(weather.coverage, 0.01);
        // Profiling only (look3.w): the old ungated heads.
        let core = coreRaw + heads * select(smoothstep(0.0, 0.25, coreRaw), 1.0, u.look3.w > 0.5);
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
        b.localH = saturate(hRel / max(smallTop, 0.01));
        // Giants (shape2.x share of the coverage; 0 = off): the shape noise at shape2.z times the tile, in
        // its own rotation, so a few cells grow several times wider, with cores scaled by shape2.y so they
        // tower up to the layer top (height grows with size, as in nature). The core is bumped by the
        // popcorn-scale shape, so a giant's outline is made of heads the size of whole small clouds
        // (cauliflower), with the detail billows on top of those.
        if (u.shape2.x > 0.0) {
            let invG = u.scales.x / max(u.shape2.z, 1.0);
            let pG = ROT_REGIONAL * ((p + u.windShape.xyz + b.skew - rise) * invG) + weather.shift * 0.5
                + vec3f(0.37, 0.11, 0.53);
            let nG = textureSampleLevel(shapeTex, noiseSampler, pG, max(0.0, log2(footprint * invG * SHAPE_TEXELS)));
            let lowG = nG.g * 0.625 + nG.b * 0.25 + nG.a * 0.125;
            let rawG = remap(remap(nG.r, lowG - 1.0, 1.0, 0.0, 1.0), 0.5, 0.95, 0.0, 1.0);
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
            let coreLRaw = max(rawU - (1.0 - covL), 0.0) / max(covL, 0.01);
            let coreL = coreLRaw + heads * select(smoothstep(0.0, 0.25, coreLRaw), 1.0, u.look3.w > 0.5);
            // Tower height grows with the mask (wider part of the giant = taller), scaled by shape2.y / 3.
            let topG = 0.08 + 0.82 * maskG * (0.8 + 0.2 * coreG) * min(u.shape2.y / 3.0, 1.0);
            // Erosion by height, held back until ~60 % of the tower (a massive column) and rising fast
            // above, so only the strongest noise cores reach the top: big rounded billowy heads, and the
            // base cut flat at the condensation level. (Eroding from 20 % up thinned towers into spires.)
            let erodeG = 1.4 * pow(smoothstep(topG * 0.3, topG, hRel), 1.6)
                + 0.3 * (1.0 - smoothstep(0.0, 0.025, hRel));
            // The giant fades out at its rim by erosion (shapes shrink), not by scaling density down: a
            // scaled fringe was a wide faint layer that the detail erosion shredded into specks of dust.
            let dG = saturate((coreL - erodeG - (1.0 - maskG) * 1.2) * u.look2.x);
            if (dG > d) { b.localH = saturate(hRel / max(topG, 0.01)); }
            d = max(d, dG);
        }
        b.density = d * smoothstep(0.0, max(smallTop * 0.08, 0.005), hRel) * mix(0.6, 1.0, weather.coverage);
    } else {
        let shape = raw * profile;
        b.localH = saturate(hRel / max(mix(0.2, 1.0, weather.kind) * mix(0.55, 1.0, weather.coverage), 0.01));
        // Coverage decides where clouds exist; small fair-weather clouds stay dense.
        b.density = remapSat(shape, 1.0 - weather.coverage, 1.0, 0.0, 1.0) * mix(0.6, 1.0, weather.coverage);
    }
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
    // Wispy (fbm) low, billowy higher up: eroding by 1 - roundBump keeps round heads around the cell
    // points with creases between (1 - fbm made sharp cone-shaped tufts that read as rock).
    let billow = 1.0 - mix(roundBump(dn.g), roundBump(dn.b), b.variety * 0.6 + 0.2);
    // Wispy-to-billowy by height: within each cloud for domes (bottom ~quarter wispy). By the layer's
    // height fraction, every small dome sat in the wispy bottom sixth and its edges looked like fur.
    let wispyToBillow = select(saturate(b.h * 6.0), saturate(b.localH * 4.0), u.march3.z > 0.5);
    let modifier = mix(fbm, billow, wispyToBillow);
    // Domes: fade the erosion out once its cells are a few pixels wide (lod: one mip per doubling of the
    // footprint over a detail texel). Thresholding sub-pixel detail cut far clouds' thin fringes into
    // single-pixel islands (dust); their silhouettes come from the base shape at that distance anyway.
    let far = select(1.0, 1.0 - smoothstep(2.5, 4.5, lod), u.march3.z > 0.5);
    return remapSat(b.density, modifier * u.density.y * mix(0.6, 1.15, b.variety) * far, 1.0, 0.0, 1.0);
}

fn cloudDensity(p: vec3f, footprint: f32, withDetail: bool) -> f32 {
    let b = cloudBase(p, footprint);
    if (!withDetail || b.density <= 0.0) { return b.density; }
    return cloudDetail(p, b, footprint);
}
`;
