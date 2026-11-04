/**
 * WGSL twin of RockModel. A shader that includes this declares
 *   var<uniform> rock: Rock;            (RockModel.pack())
 *   var heights: texture_2d<f32>;       (captured heights, r32float, read with textureLoad)
 * and calls rockColor(framePosition, pixelSizeInMetres).
 *
 * No derivative builtins and no textureSample: everything is safe in non-uniform control flow.
 * Edges (layer interfaces, vein borders) are anti-aliased from the pixel size passed in.
 */
export const rockStructsWGSL = /* wgsl */ `
struct Layer { color: vec4<f32>, accent: vec4<f32>, shape: vec4<f32>, warp: vec4<f32> }
struct Vein { color: vec4<f32>, frequency: vec4<f32>, extent: vec4<f32> }
struct Rock { header: vec4<f32>, surface: vec4<f32>, layers: array<Layer, 8>, veins: array<Vein, 4> }
`;

export const rockFunctionsWGSL = /* wgsl */ `
fn surfaceHeight(xz: vec2<f32>) -> f32 {
    let dims = vec2<i32>(textureDimensions(heights));
    let g = clamp((xz - rock.surface.xy) * rock.surface.z, vec2<f32>(0.0), vec2<f32>(dims - vec2<i32>(1)));
    let i = min(vec2<i32>(floor(g)), dims - vec2<i32>(2));
    let t = g - vec2<f32>(i);
    let a = textureLoad(heights, i, 0).r;
    let b = textureLoad(heights, i + vec2<i32>(1, 0), 0).r;
    let c = textureLoad(heights, i + vec2<i32>(0, 1), 0).r;
    let d = textureLoad(heights, i + vec2<i32>(1, 1), 0).r;
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

fn layerBottom(index: i32, xz: vec2<f32>, h: f32) -> f32 {
    let shape = rock.layers[index].shape;
    let warp = rock.layers[index].warp;
    var bottom = shape.y * h + (1.0 - shape.y) * rock.header.z - shape.x + shape.z * xz.x + shape.w * xz.y;
    if (warp.x != 0.0) {
        bottom = bottom + warp.x * noise3(vec3<f32>(xz.x * warp.y, 0.0, xz.y * warp.y), u32(warp.z));
    }
    return bottom;
}

fn layerColor(index: i32, p: vec3<f32>, below: f32, footprint: f32) -> vec3<f32> {
    let entry = rock.layers[index];
    var color = entry.color.rgb;
    let period = entry.color.a;
    if (period > 0.0) {
        let visible = clamp(period / (footprint * 6.0) - 0.5, 0.0, 1.0);
        let wave = 0.5 + 0.5 * cos(6.2831853 * below / period);
        color = mix(color, entry.accent.rgb, wave * wave * 0.7 * visible);
    }
    let mottle = entry.accent.a;
    if (mottle > 0.0) {
        let scale = entry.warp.w;
        let visible = clamp(1.0 / (scale * footprint * 3.0) - 0.5, 0.0, 1.0);
        let n = noise3(p * scale, u32(entry.warp.z) + 31u);
        color = mix(color, entry.accent.rgb, mottle * mix(0.5, 0.5 + 0.5 * n, visible));
    }
    return color;
}

fn rockColor(p: vec3<f32>, footprint: f32) -> vec3<f32> {
    let h = surfaceHeight(p.xz);
    let layerCount = i32(rock.header.x);
    let veinCount = i32(rock.header.y);
    var top = h;
    var baseLayer = 0;
    var baseTop = h;
    var partial = false;
    var color = vec3<f32>(0);
    for (var i = 1; i < layerCount; i++) {
        let boundary = min(top, layerBottom(i - 1, p.xz, h));
        let blend = clamp((boundary - p.y) / footprint + 0.5, 0.0, 1.0);
        // Interfaces never cross. No deeper layer can contribute after this one
        // has zero coverage; fully covering layers replace all earlier colors.
        if(blend <= 0.0) { break; }
        if(blend >= 1.0) {
            baseLayer=i;
            baseTop=boundary;
        } else {
            if(!partial) { color=layerColor(baseLayer,p,baseTop-p.y,footprint);partial=true; }
            color=mix(color,layerColor(i,p,boundary-p.y,footprint),blend);
        }
        top=boundary;
    }
    if(!partial) { color=layerColor(baseLayer,p,baseTop-p.y,footprint); }
    let depth = h - p.y;
    for (var v = 0; v < veinCount; v++) {
        let vein = rock.veins[v];
        let soft = max(vein.extent.z, footprint);
        let present = smoothstep(vein.extent.x - soft, vein.extent.x + soft, depth)
            * (1.0 - smoothstep(vein.extent.y - soft, vein.extent.y + soft, depth));
        if(present <= 0.0) { continue; }
        let seed = u32(vein.frequency.w);
        let f = vein.frequency.xyz;
        let field = noise3Gradient(p * f, seed);
        let n = field.x;
        let slope = field.yzw * f * footprint;
        let halfBand = 1.0 - vein.color.a;
        let inside = clamp((halfBand - abs(n)) / max(length(slope), 0.00001) + 0.5, 0.0, 1.0);
        color = mix(color, vein.color.rgb, inside * present);
    }
    return color;
}
`;