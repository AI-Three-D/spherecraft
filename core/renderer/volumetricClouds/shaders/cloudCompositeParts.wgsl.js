// Pieces of the cloud composite shared by its full and its lean form (CloudCompositePass.js, CloudLeanComposite.js).

export const CLOUD_HAZE_STRUCT_WGSL = /* wgsl */`
struct Haze {
    T: vec3f,
    L: vec3f,
}
`;

// Requires: cu, hazeRadiance, hazeTransmittance, linearSampler.
export const CLOUD_HAZE_LOOKUP_WGSL = /* wgsl */`
fn lookupHaze(uv: vec2f, distance: f32) -> Haze {
    let count = f32(textureDimensions(hazeRadiance).z);
    let depth = log2(1.0 + clamp(distance, 0.0, cu.atmo2.w)) / log2(1.0 + cu.atmo2.w);
    let uvw = vec3f(uv, (0.5 + depth * (count - 1.0)) / count);
    return Haze(textureSampleLevel(hazeTransmittance, linearSampler, uvw, 0.0).rgb,
        textureSampleLevel(hazeRadiance, linearSampler, uvw, 0.0).rgb);
}
`;

// Requires: cu, mistTable, linearSampler.
export const CLOUD_MIST_LOOKUP_WGSL = /* wgsl */`
// Optical depth of ground mist up to the cloud and up to the scene (groundMistDepths, from the table).
fn mistDepths(ro: vec3f, rd: vec3f, sceneKm: f32, cloudKm: f32) -> vec2f {
    let b = dot(ro, rd);
    let chord2 = b * b - cu.mistRay.x;
    if (chord2 <= 0.0) { return vec2f(0.0); }
    let chord = sqrt(chord2);
    let exit = chord - b;
    if (exit <= 0.0) { return vec2f(0.0); }
    let start = max(-b - chord, 0.0);
    let ground2 = b * b - cu.mistRay.y;
    let meetsGround = b < 0.0 && ground2 > 0.0;
    let path = select(exit, -b - sqrt(max(ground2, 0.0)), meetsGround) - start;
    if (path <= 0.0) { return vec2f(0.0); }
    let size = vec2f(textureDimensions(mistTable));
    let half = 0.5 * size.x;
    let range = select(cu.mistPath.zw, cu.mistPath.xy, meetsGround);
    let x = (select(half, 0.0, meetsGround) + 0.5 + saturate((path - range.x) * range.y) * (half - 1.0)) / size.x;
    let y = (0.5 + saturate((vec2f(cloudKm, sceneKm) - start) / path) * (size.y - 1.0)) / size.y;
    return vec2f(textureSampleLevel(mistTable, linearSampler, vec2f(x, y.x), 0.0).r,
        textureSampleLevel(mistTable, linearSampler, vec2f(x, y.y), 0.0).r) * cu.mistRay.z;
}
`;

// Requires: u, cu.
export const CLOUD_MIST_LIGHT_WGSL = /* wgsl */`
fn groundMistLight(ro: vec3f, rd: vec3f) -> vec3f {
    let up = normalize(ro);
    let sunAbove = dot(up, u.sun.xyz);
    let day = smoothstep(-0.12, 0.19, sunAbove);
    let warm = (1.0 - smoothstep(0.01, 0.28, sunAbove)) * smoothstep(-0.12, 0.02, sunAbove);
    let daylight = mix(vec3f(0.030, 0.037, 0.043), vec3f(0.060, 0.043, 0.034), warm);
    let forward = 1.0 + 0.32 * pow(max(0.0, dot(rd, u.sun.xyz)), 5.0);
    let sun = daylight * (cu.atmo2.y * day * forward * (1.0 - 0.48 * u.weatherStyle.y));
    let moon = vec3f(0.08, 0.10, 0.15) * (u.moon.w * smoothstep(-0.08, 0.25, dot(up, u.moon.xyz)));
    return sun + moon + u.ambientFloor.rgb;
}
`;

// Requires: u, cu, aerial perspective.
export const CLOUD_SURFACE_VISIBILITY_WGSL = /* wgsl */`
// Rough luminance transmittance to a surface (mean-altitude density): how much of the pixel is
// the surface itself rather than haze in front of it.
fn surfaceVisibility(roKm: vec3f, rd: vec3f, distKm: f32) -> f32 {
    let h0 = length(roKm) - u.planet.x;
    let h1 = length(roKm + rd * distKm) - u.planet.x;
    let d = ap_getDensity(max(0.5 * (h0 + h1), 0.0) * cu.viewport.w, cu.atmo0.z, cu.atmo0.w);
    let ext = cu.atmo1.xyz * d.x + vec3f(cu.atmo1.w * d.y);
    return dot(exp(-ext * distKm * cu.viewport.w), vec3f(0.2126, 0.7152, 0.0722));
}
`;

// Requires: cloudColor, cloudDepth, linearSampler, pointSampler.
export const CLOUD_UPSAMPLE_WGSL = /* wgsl */`
struct UpsampledCloud {
    color: vec4f,
    depth: f32,
}

fn upsampleCloud(uv: vec2f, cloudSize: vec2i, opaque: bool) -> UpsampledCloud {
    // Negative depths mark rays clipped by opaque geometry. Keep their colours and haze depths
    // on the terrain side of a silhouette, even when all four bilinear taps were clipped.
    let sp = uv * vec2f(cloudSize) - 0.5;
    let i0 = vec2i(floor(sp));
    let f = sp - floor(sp);
    // Vectors throughout: indexing a local array spills it to memory.
    // A gather starts at the bottom left and turns counterclockwise.
    let depths = textureGather(0, cloudDepth, pointSampler, (vec2f(i0) + 1.0) / vec2f(cloudSize)).wzxy;
    let matching = (depths < vec4f(0.0)) == vec4<bool>(opaque);
    if (!all(matching)) {
        let gx = vec2f(1.0 - f.x, f.x);
        let w4 = select(vec4f(0.0), vec4f(gx * (1.0 - f.y), gx * f.y), matching);
        var sumW = dot(w4, vec4f(1.0));
        var sumC = vec4f(0.0);
        var sumDepth = 0.0;
        var depthWeight = 0.0;
        if (sumW > 1.0e-4) {
            let last = cloudSize - 1;
            let c0 = textureLoad(cloudColor, clamp(i0, vec2i(0), last), 0);
            let c1 = textureLoad(cloudColor, clamp(i0 + vec2i(1, 0), vec2i(0), last), 0);
            let c2 = textureLoad(cloudColor, clamp(i0 + vec2i(0, 1), vec2i(0), last), 0);
            let c3 = textureLoad(cloudColor, clamp(i0 + 1, vec2i(0), last), 0);
            sumC = c0 * w4.x + c1 * w4.y + c2 * w4.z + c3 * w4.w;
            let solid = w4 * saturate(1.0 - vec4f(c0.a, c1.a, c2.a, c3.a));
            sumDepth = dot(abs(depths), solid);
            depthWeight = dot(solid, vec4f(1.0));
        } else {
            // No matching tap inside the pixel's own square, so look around it.
            sumW = 0.0;
            for (var y = -1; y <= 2; y++) {
                for (var x = -1; x <= 2; x++) {
                    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) { continue; }
                    let delta = vec2i(x, y);
                    let tp = clamp(i0 + delta, vec2i(0), cloudSize - 1);
                    let depth = textureLoad(cloudDepth, tp, 0).r;
                    if ((depth < 0.0) != opaque) { continue; }
                    let d = vec2f(delta) - f;
                    let w = exp(-dot(d, d));
                    let c = textureLoad(cloudColor, tp, 0);
                    let dw = w * saturate(1.0 - c.a);
                    sumW += w;
                    sumC += c * w;
                    sumDepth += abs(depth) * dw;
                    depthWeight += dw;
                }
            }
        }
        // A sub-texel opening can have no sky rays in the neighbourhood.
        if (sumW > 1.0e-4) { return UpsampledCloud(sumC / sumW, sumDepth / max(depthWeight, 1.0e-8)); }
    }
    let row = select(depths.xy, depths.zw, f.y >= 0.5);
    return UpsampledCloud(sampleCatmullRom(cloudColor, linearSampler, uv), abs(select(row.x, row.y, f.x >= 0.5)));
}
`;

// Requires: cu, rayVolume (texture_3d), linearSampler.
export const CLOUD_RAY_LOOKUP_WGSL = /* wgsl */`
// God rays up to a distance: rgb light to add, a the share of the host's haze that the sun reaches.
fn lookupRays(uv: vec2f, km: f32) -> vec4f {
    let count = f32(textureDimensions(rayVolume).z);
    let depth = log2(1.0 + min(km, cu.rays.z)) / log2(1.0 + cu.rays.z);
    let rays = textureSampleLevel(rayVolume, linearSampler, vec3f(uv, (0.5 + depth * (count - 1.0)) / count), 0.0);
    return vec4f(rays.rgb, 1.0 - (1.0 - rays.a) * cu.rays.y);
}
`;
