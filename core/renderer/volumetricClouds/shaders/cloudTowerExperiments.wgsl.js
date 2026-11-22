import {
    CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_ATMOSPHERE_WGSL, CLOUD_RAY_INPUT_WGSL, CLOUD_LAYER_BLEND_WGSL,
} from './cloudCommon.wgsl.js';

export const TOWER_COUNT = 6;
export const TOWER_CACHE_SIZE = 20;
export const TOWER_DENSITY_SIZE = 48;
export const TOWER_IMPOSTOR_SIZE = 64;
export const TOWER_IMPOSTOR_VIEWS = 6;

const TOWER_DATA = /* wgsl */`
const CACHE_SIZE: u32 = ${TOWER_CACHE_SIZE}u;
const MAX_TOWERS: u32 = ${TOWER_COUNT}u;
struct Tower {
    center: vec4f,
    east: vec4f,  // unit axis divided by the corresponding radius in km
    up: vec4f,
    north: vec4f,
}
struct TowerData {
    options: vec4f, // count, impostor start distance, impostor full distance
    items: array<Tower, MAX_TOWERS>,
}
fn towerLocal(tower: Tower, v: vec3f) -> vec3f {
    return vec3f(dot(v, tower.east.xyz), dot(v, tower.up.xyz), dot(v, tower.north.xyz));
}

// In local coordinates each tower is bounded by the unit sphere.
fn towerIntersection(origin: vec3f, direction: vec3f) -> vec2f {
    let a = dot(direction, direction);
    let b = dot(origin, direction);
    let c = dot(origin, origin) - 1.0;
    let d = b * b - a * c;
    if (d <= 0.0) { return vec2f(1.0e30, -1.0e30); }
    let root = sqrt(d);
    return vec2f(-b - root, -b + root) / a;
}
`;

// The same baked, local-space volume feeds the live march, the light cache,
// and every impostor view. Instances rotate it around the planet's radial axis.
export const CLOUD_TOWER_DENSITY_WGSL = /* wgsl */`
@group(0) @binding(0) var shape: texture_3d<f32>;
@group(0) @binding(1) var noiseSampler: sampler;
@group(0) @binding(2) var densityOut: texture_storage_3d<rgba16float, write>;

fn lobe(p: vec3f, center: vec3f, radius: vec3f) -> f32 {
    return 1.0 - length((p - center) / radius);
}

fn joinLobes(a: f32, b: f32) -> f32 {
    let overlap = max(0.21 - abs(a - b), 0.0);
    return max(a, b) + overlap * overlap / 0.84;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(densityOut);
    if (any(id >= size)) { return; }
    let p = (vec3f(id) + 0.5) / vec3f(size) * 2.0 - 1.0;
    var d = 0.0;
    if (dot(p, p) < 1.0) {
        let n = textureSampleLevel(shape, noiseSampler, p * 1.1 + vec3f(0.72, 0.31, 0.58), 0.0);
        let q = p + (n.gba - 0.6) * 0.19;
        var hull = lobe(q, vec3f(0.02, -0.34, 0.0), vec3f(0.60, 0.52, 0.54));
        hull = joinLobes(hull, lobe(q, vec3f(0.08, 0.03, -0.06), vec3f(0.49, 0.46, 0.47)));
        hull = joinLobes(hull, lobe(q, vec3f(-0.07, 0.38, 0.04), vec3f(0.40, 0.44, 0.35)));
        hull = joinLobes(hull, lobe(q, vec3f(-0.17, 0.64, 0.08), vec3f(0.31, 0.26, 0.31)));
        hull = joinLobes(hull, lobe(q, vec3f(-0.47, -0.21, 0.04), vec3f(0.37, 0.37, 0.36)));
        hull = joinLobes(hull, lobe(q, vec3f(0.39, 0.10, -0.11), vec3f(0.33, 0.34, 0.28)));
        hull = joinLobes(hull, lobe(q, vec3f(0.10, 0.19, 0.39), vec3f(0.28, 0.34, 0.34)));
        let fine = textureSampleLevel(shape, noiseSampler, q * 3.6 + vec3f(0.25, 0.59, 0.15), 0.0);
        let fringe = (0.6 * n.b + 0.4 * fine.r - 0.67) * 0.47;
        d = 0.19 * smoothstep(-0.075, 0.22, hull + fringe) * smoothstep(0.0, 0.10, 1.0 - dot(p, p));
    }
    textureStore(densityOut, vec3i(id), vec4f(d, 0.0, 0.0, 0.0));
}
`;

const TOWER_DENSITY = /* wgsl */`
fn towerDensity(p: vec3f) -> f32 {
    return textureSampleLevel(towerShape, towerNoise, p * 0.5 + 0.5, 0.0).r;
}
`;

const TOWER_LIGHT_MARCH = /* wgsl */`
fn towerLightDepth(point: vec3f, direction: vec3f) -> f32 {
    let end = min(4.0, towerIntersection(point, direction).y);
    if (end <= 0.0) { return 0.0; }
    let steps = 6;
    let ds = end / f32(steps);
    var density = 0.0;
    for (var i = 0; i < steps; i++) {
        let t = (f32(i) + 0.5) * ds;
        density += towerDensity(point + direction * t);
    }
    return density * ds;
}
`;

const TOWER_VIEW = /* wgsl */`
fn impostorDirection(face: u32) -> vec3f {
    let signD = select(1.0, -1.0, (face & 1u) != 0u);
    var axis = vec3f(0.0);
    axis[face / 2u] = signD;
    return axis;
}

fn impostorAxes(dir: vec3f) -> mat2x3f {
    let up = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(dir.y) > 0.5);
    return mat2x3f(cross(dir, up), up);
}
`;

export const CLOUD_TOWER_CACHE_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${TOWER_DATA}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> towers: TowerData;
@group(0) @binding(2) var towerShape: texture_3d<f32>;
@group(0) @binding(3) var towerNoise: sampler;
@group(0) @binding(4) var cacheOut: texture_storage_3d<rgba16float, write>;
${TOWER_DENSITY}${TOWER_LIGHT_MARCH}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let index = id.z / CACHE_SIZE;
    if (id.x >= CACHE_SIZE || id.y >= CACHE_SIZE || index >= u32(towers.options.x)) { return; }
    let cell = vec3u(id.xy, id.z % CACHE_SIZE);
    let p = (vec3f(cell) + 0.5) * (2.0 / f32(CACHE_SIZE)) - 1.0;
    let tower = towers.items[index];
    var depths = vec2f(0.0);
    // Near-boundary voxels can contribute to valid trilinear samples.
    if (dot(p, p) < 1.18) {
        depths.x = towerLightDepth(p, towerLocal(tower, u.sun.xyz));
        if (u.moon.w > 0.0) { depths.y = towerLightDepth(p, towerLocal(tower, u.moon.xyz)); }
    }
    textureStore(cacheOut, vec3i(id), vec4f(depths, 0.0, 0.0));
}
`;

export const CLOUD_TOWER_IMPOSTOR_WGSL = /* wgsl */`
@group(0) @binding(0) var towerShape: texture_3d<f32>;
@group(0) @binding(1) var towerNoise: sampler;
@group(0) @binding(2) var impostorOut: texture_storage_2d_array<rgba16float, write>;
${TOWER_DENSITY}${TOWER_VIEW}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(impostorOut);
    if (any(id.xy >= size)) { return; }
    let dir = impostorDirection(id.z);
    let basis = impostorAxes(dir);
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size) * 2.0 - 1.0;
    let origin = basis[0] * uv.x + basis[1] * uv.y;
    let radius = sqrt(max(0.0, 1.0 - dot(uv, uv)));
    var packed = vec4f(0.0);
    if (radius > 0.0) {
        let steps = 32;
        let ds = 2.0 * radius / f32(steps);
        var front = 1.0;
        var back = -1.0;
        var sum = 0.0;
        var height = 0.0;
        for (var i = 0; i < steps; i++) {
            let t = -radius + (f32(i) + 0.5) * ds;
            let p = origin + dir * t;
            let d = towerDensity(p);
            if (d > 0.0) {
                front = min(front, t - 0.5 * ds);
                back = max(back, t + 0.5 * ds);
                sum += d;
                height += d * p.y;
            }
        }
        // Store weighted depths so filtering across the silhouette does not
        // pull a valid front or back depth toward zero.
        packed = ds * vec4f(sum, front * sum, back * sum, height);
    }
    textureStore(impostorOut, vec2i(id.xy), i32(id.z), packed);
}
`;

export const CLOUD_TOWER_RENDER_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}${TOWER_DATA}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> towers: TowerData;
@group(0) @binding(2) var towerShape: texture_3d<f32>;
@group(0) @binding(3) var towerNoise: sampler;
@group(0) @binding(4) var transmittance: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;
@group(0) @binding(6) var lightCache: texture_3d<f32>;
@group(0) @binding(7) var impostors: texture_2d_array<f32>;
@group(0) @binding(8) var baseColor: texture_2d<f32>;
@group(0) @binding(9) var baseDepth: texture_2d<f32>;
@group(0) @binding(10) var sceneDepth: texture_depth_2d;
@group(0) @binding(11) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var outDepth: texture_storage_2d<r32float, write>;
${CLOUD_RAY_INPUT_WGSL}${CLOUD_LAYER_BLEND_WGSL}${TOWER_DENSITY}${TOWER_LIGHT_MARCH}${TOWER_VIEW}

override TOWER_MODE: u32 = 0u; // live, cached light, distant impostor
override TOWER_WORK: u32 = 0u; // full, density timing, bounds timing
const EMPTY = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), FAR_DEPTH);

struct TowerLight {
    sun: vec3f,
    moon: vec3f,
    ambient: vec3f,
    sunDir: vec3f,
    moonDir: vec3f,
}

fn towerLight(tower: Tower, rd: vec3f) -> TowerLight {
    let r = length(tower.center.xyz);
    let n = tower.center.xyz / r;
    let phase = clamp(henyeyGreenstein(dot(rd, u.sun.xyz), 0.53), 0.035, 0.35);
    let mu = dot(n, u.sun.xyz);
    let sun = sunTransmittance(transmittance, linearSampler, r, mu, u.planet.x, u.planet.w)
        * (u.sun.w * (0.105 + 0.50 * phase));
    let moon = sunTransmittance(transmittance, linearSampler, r, dot(n, u.moon.xyz), u.planet.x, u.planet.w)
        * (u.moon.w * 0.075);
    let sky = vec3f(0.49, 0.62, 0.83) * (0.078 * u.sun.w * smoothstep(-0.12, 0.14, mu));
    return TowerLight(sun, moon, sky + u.ambientFloor.rgb, towerLocal(tower, u.sun.xyz), towerLocal(tower, u.moon.xyz));
}

fn shadedTower(light: TowerLight, h: f32, depths: vec2f) -> vec3f {
    let od = depths * u.density.x;
    let multi = exp(-0.34 * od) * 0.59 + exp(-od) * 0.41;
    return light.ambient * mix(0.43, 1.0, saturate(0.5 + h * 0.5)) + light.sun * multi.x + light.moon * multi.y;
}

fn cachedDepth(index: u32, p: vec3f) -> vec2f {
    let size = f32(CACHE_SIZE);
    let voxel = clamp((p * 0.5 + 0.5) * size, vec3f(0.5), vec3f(size - 0.5));
    let z = (voxel.z + f32(index) * size) / (size * f32(MAX_TOWERS));
    return textureSampleLevel(lightCache, linearSampler, vec3f(voxel.xy / size, z), 0.0).rg;
}

fn towerMarch(index: u32, origin: vec3f, direction: vec3f, span: vec2f, light: TowerLight,
              distance: f32) -> MarchResult {
    // A partial last step grows continuously as the chord length changes.
    let chord = span.y - span.x;
    let desired = mix(0.10, 0.32, smoothstep(4.0, 25.0, distance));
    let stepKm = clamp(desired, chord / 48.0, chord / 4.0);
    var T = 1.0;
    var color = vec3f(0.0);
    var depthSum = 0.0;
    for (var i = 0; i < 48; i++) {
        let start = span.x + f32(i) * stepKm;
        let ds = min(stepKm, span.y - start);
        if (ds <= 0.0) { break; }
        let t = start + 0.5 * ds;
        let p = origin + direction * t;
        let density = towerDensity(p);
        if (density <= 0.0) { continue; }
        let stepT = exp(-density * u.density.x * ds);
        let weight = T * (1.0 - stepT);
        var radiance = vec3f(0.25);
        if (TOWER_WORK == 0u) {
            var depths = vec2f(0.0);
            if (TOWER_MODE == 0u) {
                depths.x = towerLightDepth(p, light.sunDir);
                if (u.moon.w > 0.0) { depths.y = towerLightDepth(p, light.moonDir); }
            } else {
                depths = cachedDepth(index, p);
            }
            radiance = shadedTower(light, p.y, depths);
        }
        color += weight * radiance;
        depthSum += weight * t;
        T *= stepT;
        if (T < 0.009) { break; }
    }
    if (T > 0.99999) { return EMPTY; }
    return MarchResult(vec4f(color, T), depthSum / (1.0 - T));
}

fn towerImpostor(origin: vec3f, direction: vec3f, span: vec2f, light: TowerLight) -> MarchResult {
    // Blend the three signed axis views. A view's weight reaches zero before
    // its sign changes, keeping the selected representation continuous.
    let viewDir = normalize(direction);
    let axes = abs(viewDir);
    let weights = axes * axes;
    var opacity = 0.0;
    var depthSum = 0.0;
    var heightSum = 0.0;
    let unitToKm = 1.0 / length(direction);
    for (var axis = 0u; axis < 3u; axis++) {
        if (weights[axis] < 0.002) { continue; }
        let face = axis * 2u + select(0u, 1u, viewDir[axis] < 0.0);
        let dir = impostorDirection(face);
        let basis = impostorAxes(dir);
        let denom = dot(direction, dir);
        let p = origin - direction * (dot(origin, dir) / denom);
        let uv = vec2f(dot(p, basis[0]), dot(p, basis[1])) * 0.5 + 0.5;
        if (any(abs(uv - 0.5) >= vec2f(0.5))) { continue; }
        let baked = textureSampleLevel(impostors, linearSampler, uv, i32(face), 0.0);
        if (baked.r < 1.0e-5) { continue; }
        let depths = (baked.gb / baked.r - dot(origin, dir)) / denom;
        let near = max(span.x, depths.x);
        let far = min(span.y, depths.y);
        if (far <= near) { continue; }
        let chord = (far - near) / max(depths.y - depths.x, 1.0e-4);
        let weight = weights[axis] * (1.0 - exp(-u.density.x * baked.r * unitToKm * chord));
        opacity += weight;
        depthSum += weight * mix(near, far, 0.35);
        heightSum += weight * baked.a / baked.r;
    }
    if (opacity < 1.0e-5) { return EMPTY; }
    let height = heightSum / opacity;
    let depth = depthSum / opacity;
    let od = vec2f(mix(0.18, 0.045, saturate(0.60 + height * 0.40)));
    return MarchResult(vec4f(shadedTower(light, height, od) * opacity, 1.0 - opacity), depth);
}

fn towerResult(index: u32, origin: vec3f, direction: vec3f, span: vec2f, rd: vec3f) -> MarchResult {
    if (TOWER_WORK == 2u) { return MarchResult(vec4f(0.05, 0.10, 0.15, 0.8), span.x); }
    let tower = towers.items[index];
    var light: TowerLight;
    if (TOWER_WORK == 0u) { light = towerLight(tower, rd); }
    let distance = length(tower.center.xyz - u.camPos.xyz);
    if (TOWER_MODE != 2u) { return towerMarch(index, origin, direction, span, light, distance); }
    let weight = smoothstep(towers.options.y, towers.options.z, distance);
    if (weight >= 1.0) { return towerImpostor(origin, direction, span, light); }
    let volume = towerMarch(index, origin, direction, span, light, distance);
    if (weight <= 0.0) { return volume; }
    let proxy = towerImpostor(origin, direction, span, light);
    let color = mix(volume.color, proxy.color, weight);
    let depths = vec2f((1.0 - weight) * (1.0 - volume.color.a), weight * (1.0 - proxy.color.a));
    let depth = dot(depths, vec2f(volume.depth, proxy.depth)) / max(depths.x + depths.y, 1.0e-5);
    return MarchResult(color, depth);
}

fn blendOverlappingClouds(front: MarchResult, back: MarchResult) -> MarchResult {
    let regular = blendCloudLayers(front, back);
    if (max(front.color.a, back.color.a) > 0.9999 || abs(back.depth - front.depth) >= 0.5) { return regular; }
    // A ray carries a representative depth for the main field. Fade between
    // the two composite orders when that depth falls inside a tower.
    let reverse = blendCloudLayers(back, front);
    let weight = smoothstep(-0.5, 0.5, back.depth - front.depth);
    return MarchResult(mix(reverse.color, regular.color, weight), mix(reverse.depth, regular.depth, weight));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(outColor))) { return; }
    let pixel = vec2i(id.xy);
    let signedDepth = textureLoad(baseDepth, pixel, 0).x;
    var result = MarchResult(textureLoad(baseColor, pixel, 0), abs(signedDepth));

    let ray = cloudRay(id.xy);
    let ground = raySphere(u.camPos.xyz, ray.direction, u.planet.x);
    var limit = ray.sceneDistance;
    if (ground.x < ground.y && ground.y > 0.0) { limit = min(limit, max(0.0, ground.x)); }

    // The sites are widely spaced. Keep depth ordering if their projections
    // overlap, without paying for a per-pixel sort on rays that miss them.
    var hits: array<MarchResult, MAX_TOWERS + 1u>;
    hits[0] = result;
    var count = 1u;
    for (var i = 0u; i < u32(towers.options.x); i++) {
        let tower = towers.items[i];
        let origin = towerLocal(tower, u.camPos.xyz - tower.center.xyz);
        let direction = towerLocal(tower, ray.direction);
        let bounds = towerIntersection(origin, direction);
        let span = vec2f(max(bounds.x, 0.0), min(bounds.y, limit));
        if (span.y <= span.x) { continue; }
        let cloud = towerResult(i, origin, direction, span, ray.direction);
        if (cloud.color.a >= 0.9999) { continue; }
        var pos = count;
        while (pos > 0u) {
            if (hits[pos - 1u].depth <= cloud.depth) { break; }
            hits[pos] = hits[pos - 1u];
            pos -= 1u;
        }
        hits[pos] = cloud;
        count++;
    }
    result = hits[0];
    for (var i = 1u; i < count; i++) { result = blendOverlappingClouds(result, hits[i]); }
    textureStore(outColor, pixel, result.color);
    let depth = select(result.depth, -max(result.depth, 1.0e-3), signedDepth < 0.0);
    textureStore(outDepth, pixel, vec4f(depth, 0.0, 0.0, 0.0));
}
`;
