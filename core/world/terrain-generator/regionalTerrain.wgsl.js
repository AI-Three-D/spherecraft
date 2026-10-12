// One persistent macro tier, shared by terrain tiles and hydrology sampling.
// The old features below this tier still evaluate at their original scales.
import {createRegionalValleyFeatureWgsl} from './regionalValleyFeature.wgsl.js';

export function createRegionalTerrainWgsl({ enabled = false, valleyFeature = false, shape = false } = {}) {
    const direct = `
fn terrainMacroDirect_d(dir: vec3<f32>, seed: i32, profile: TerrainProfile) -> TerrainMacroD {
    var out: TerrainMacroD;
    out.regional = getRegionalCharacter_d(dir, seed, profile);
    out.region.coord = dConst(REGION_HIGHLAND_START);
    out.region.height = dConst(0.0);
    out.region.rough = dConst(1.0);
    if (out.regional.landMask.x > 0.15 && terrainFeatureOn(TF_LAND_REGIONS)) {
        out.region = landRegions_d(dir, seed, out.regional);
    }
    return out;
}
`;
    const header = `
struct TerrainMacroD {
    regional: RegionalInfoD,
    region: LandRegionD,
}
`;
    if (!enabled) return header + direct + createRegionalValleyFeatureWgsl(false) + `
fn regionalBasinApply_d(height: vec4<f32>, dir: vec3<f32>) -> vec4<f32> { return height; }
fn regionalBasinMicroKeep(dir: vec3<f32>) -> f32 { return 1.0; }
fn regionalLakeShoreLevel(dir: vec3<f32>) -> f32 { return -1.0e20; }
fn regionalLakeShoreWeight(dir: vec3<f32>) -> f32 { return 1.0; }
fn terrainMacro_d(dir: vec3<f32>, seed: i32, profile: TerrainProfile) -> TerrainMacroD {
    return terrainMacroDirect_d(dir, seed, profile);
}
`;
    return header + direct + createRegionalValleyFeatureWgsl(valleyFeature) + `
struct RegionalTerrainParams { cells: f32, seamCells: f32, basinCount: f32, _pad: f32, }
@group(2) @binding(0) var regionalMacroA: texture_2d_array<f32>;
@group(2) @binding(1) var regionalMacroB: texture_2d_array<f32>;
@group(2) @binding(2) var<uniform> regionalTerrainParams: RegionalTerrainParams;
struct RegionalBasin {
    centreRadius: vec4<f32>, levelDepth: vec4<f32>, axisCut: vec4<f32>,
    radialControls: array<vec2<f32>,16>,
}
@group(2) @binding(3) var<storage, read> regionalBasins: array<RegionalBasin>;

fn regionalBasinCandidates(dir: vec3<f32>) -> vec4<i32> {
    ${shape ? `if(regionalShapeParams.limits.z==-2.0) {
        let fp=mtnFacePos(dir);let grid=i32(regionalShapeParams.address.y);
        let cell=clamp(vec2<i32>(floor((vec2<f32>(fp.x,fp.y)*0.5+0.5)*f32(grid))),vec2<i32>(0),vec2<i32>(grid-1));
        let entry=regionalShapeDirectory(cell,fp.face);
        return vec4<i32>(vec3<i32>(entry.yzw)-vec3<i32>(1),3);
    }` : ''}
    return vec4<i32>(-1,-1,-1,i32(regionalTerrainParams.basinCount));
}
fn regionalBasinCandidateIndex(candidates: vec4<i32>,i: i32) -> i32 {
    ${shape?`if(regionalShapeParams.limits.z==-2.0) { return candidates[u32(i)]; }`:''}
    return i;
}

// Existing ownership and level, without another height evaluation or mask.
fn regionalLakeShoreWeight(dir: vec3<f32>) -> f32 {
    ${shape ? 'return regionalShapeShoreWeight(dir);' : 'return 1.0;'}
}
fn regionalLakeShoreLevel(dir: vec3<f32>) -> f32 {
    ${shape ? `let level=regionalShapeShoreLevel(dir);if(level>-1.0e19) { return level; }` : ''}
    let candidates=regionalBasinCandidates(dir);
    for(var j=0;j<candidates.w;j++) {
        let i=regionalBasinCandidateIndex(candidates,j);if(i<0) { continue; }
        let b=regionalBasins[u32(i)];let den=dot(dir,b.centreRadius.xyz);
        if(den<=0.0) { continue; }
        let distance=length(dir-b.centreRadius.xyz*den)/den*noiseReferenceRadiusM();
        if(distance<b.centreRadius.w*1.6) { return b.levelDepth.x; }
    }
    return -1.0e20;
}

struct BasinLocal { u: vec4<f32>, v: vec4<f32>, }
fn regionalBasinLocal_d(basin: RegionalBasin, dir: vec3<f32>) -> BasinLocal {
    let c=basin.centreRadius.xyz; let den=dot(dir,c);
    let tangent=dir-c*den;
    let axis=normalize(basin.axisCut.xyz-c*dot(c,basin.axisCut.xyz));
    let crossAxis=normalize(cross(c,axis));
    let scale=noiseReferenceRadiusM()/basin.centreRadius.w;
    let nu=dot(tangent,axis); let nv=dot(tangent,crossAxis);
    let u=vec4<f32>(nu/den*scale,((axis-c*dot(c,axis))/den-c*(nu/(den*den)))*scale);
    let v=vec4<f32>(nv/den*scale,((crossAxis-c*dot(c,crossAxis))/den-c*(nv/(den*den)))*scale);
    return BasinLocal(u,v);
}

// Periodic cubic spline of start/outer radii. Positive weights preserve
// node bounds: start>=.20, outer<=.96, transition width>=.12. The profile
// stays strictly inside the independently certified enclosing circle.
fn regionalBasinWeight_d(basin: RegionalBasin, p: BasinLocal, r2: vec4<f32>) -> vec4<f32> {
    if(r2.x<=0.20*0.20) { return dConst(1.0); }
    if(r2.x>=0.96*0.96) { return dConst(0.0); }
    let angle=atan2(p.v.x,p.u.x);
    let phase=(angle/6.28318530718+1.0)*16.0;
    let phaseGradient=(p.u.x*p.v.yzw-p.v.x*p.u.yzw)/r2.x*(16.0/6.28318530718);
    let cell=i32(floor(phase));let t=fract(phase);
    let w=regionalSpline(t);let dw=regionalSplineD(t);
    var radii=vec2<f32>(0.0);var derivatives=vec2<f32>(0.0);
    for(var i=0;i<4;i++) {
        let node=basin.radialControls[u32((cell+i-1)&15)];
        radii+=node*w[i];derivatives+=node*dw[i];
    }
    let start=vec4<f32>(radii.x,phaseGradient*derivatives.x);
    let outer=vec4<f32>(radii.y,phaseGradient*derivatives.y);
    let progress=dDiv(dSqrt(r2)-start,outer-start);
    return dConst(1.0)-dQuintic(dClamp(progress,0.0,1.0));
}

// Subtract a shallow, varying depression from the natural terrain rather
// than replacing its above-water banks with a bowl surface. Existing meso,
// erosion and material micro undulations survive there. A small inner cap
// guarantees a connected wet disk independently of the fitted shape.
fn regionalBasinApply_d(height: vec4<f32>, dir: vec3<f32>) -> vec4<f32> {
    var h = ${shape?'regionalShapeBasinApply_d(height,dir)':'height'};
    let candidates=regionalBasinCandidates(dir);
    for(var j=0;j<candidates.w;j++) {
        let i=regionalBasinCandidateIndex(candidates,j);if(i<0) { continue; }
        let basin = regionalBasins[u32(i)];
        let dotC = dot(dir,basin.centreRadius.xyz);
        if(dotC<=0.0) { continue; }
        // Cheap circle rejection before angular spline evaluation.
        let tangent=dir-basin.centreRadius.xyz*dotC;
        let radius2=dot(tangent,tangent)/(dotC*dotC)*pow(noiseReferenceRadiusM()/basin.centreRadius.w,2.0);
        if(radius2>=0.96*0.96) { continue; }
        let p=regionalBasinLocal_d(basin,dir);
        let r2=dMul(p.u,p.u)+dMul(p.v,p.v);
        h-=regionalBasinWeight_d(basin,p,r2)*(basin.axisCut.w/maxTerrainHeightM());
        let core=dConst(1.0)-dQuintic(dClamp((r2-dConst(0.12*0.12))/(0.20*0.20-0.12*0.12),0.0,1.0));
        let bed=dConst((basin.levelDepth.x-basin.levelDepth.y-0.05)/maxTerrainHeightM());
        h=dMix(h,dSmoothMin(h,bed,0.1/maxTerrainHeightM()),core);
    }
    return h;
}
fn regionalBasinMicroKeep(dir: vec3<f32>) -> f32 {
    var keep = 1.0;
    let candidates=regionalBasinCandidates(dir);
    for(var j=0;j<candidates.w;j++) {
        let i=regionalBasinCandidateIndex(candidates,j);if(i<0) { continue; }
        let basin = regionalBasins[u32(i)];
        let d = dot(dir,basin.centreRadius.xyz);
        if(d<=0.0) { continue; }
        let tangent=dir-basin.centreRadius.xyz*d;
        let r2=dot(tangent,tangent)/(d*d)*pow(noiseReferenceRadiusM()/basin.centreRadius.w,2.0);
        keep *= smoothstep(0.12*0.12,0.24*0.24,r2);
    }
    return ${shape?'keep*regionalShapeMicroKeep(dir)':'keep'};
}

// Cubic B-spline weights: nonnegative, sum to one, C2. Unlike interpolating
// cubics these cannot overshoot their 4x4 control footprint. Their analytic
// derivatives drive the SAME existing erosion filter as before.
fn regionalSpline(t: f32) -> vec4<f32> {
    let a = 1.0 - t;
    return vec4<f32>(a*a*a, 3.0*t*t*t-6.0*t*t+4.0,
        -3.0*t*t*t+3.0*t*t+3.0*t+1.0, t*t*t) / 6.0;
}
fn regionalSplineD(t: f32) -> vec4<f32> {
    let a = 1.0 - t;
    return vec4<f32>(-3.0*a*a, 9.0*t*t-12.0*t,
        -9.0*t*t+6.0*t+3.0, 3.0*t*t) / 6.0;
}

fn terrainMacro_d(dir: vec3<f32>, seed: i32, profile: TerrainProfile) -> TerrainMacroD {
    let fp = mtnFacePos(dir);
    let normal = mtnCubePoint(fp.face, 0.0, 0.0);
    let axisU = mtnCubePoint(fp.face, 1.0, 0.0) - normal;
    let axisV = mtnCubePoint(fp.face, 0.0, 1.0) - normal;
    let den = dot(dir, normal);
    let uv = vec2<f32>(fp.x, fp.y) * 0.5 + 0.5;
    let gu = (axisU - normal * fp.x) / (2.0 * den);
    let gv = (axisV - normal * fp.y) / (2.0 * den);
    let cells = regionalTerrainParams.cells;
    let edgeU = min(uv.x, 1.0 - uv.x);
    let edgeV = min(uv.y, 1.0 - uv.y);
    // Gnomonic lattices do not have identical cross-face spline footprints.
    // Keep the existing analytic field at the cube seam, blending with full
    // derivatives over a C2 guard. This is a measured prototype limitation,
    // not a claim of globally seamless cross-face spline interpolation.
    let guardU = dQuintic(dClamp(vec4<f32>(edgeU * cells,
        gu * select(1.0, -1.0, uv.x > 0.5) * cells) / regionalTerrainParams.seamCells, 0.0, 1.0));
    let guardV = dQuintic(dClamp(vec4<f32>(edgeV * cells,
        gv * select(1.0, -1.0, uv.y > 0.5) * cells) / regionalTerrainParams.seamCells, 0.0, 1.0));
    let guard = dMul(guardU, guardV);
    if (guard.x <= 0.0) { return terrainMacroDirect_d(dir, seed, profile); }
    let pos = uv * cells;
    let cell = min(vec2<i32>(floor(pos)), vec2<i32>(i32(cells) - 1));
    let t = pos - vec2<f32>(cell);
    let wu = regionalSpline(t.x);
    let wv = regionalSpline(t.y);
    let du = regionalSplineD(t.x);
    let dv = regionalSplineD(t.y);
    var values: array<vec4<f32>, 8>;
    for (var j = 0; j < 4; j++) {
        for (var i = 0; i < 4; i++) {
            let w = vec4<f32>(wu[i] * wv[j],
                (gu * du[i] * wv[j] + gv * wu[i] * dv[j]) * cells);
            let a = textureLoad(regionalMacroA, cell + vec2<i32>(i, j), fp.face, 0);
            let b = textureLoad(regionalMacroB, cell + vec2<i32>(i, j), fp.face, 0);
            for (var k = 0; k < 4; k++) {
                values[k] += w * a[k];
                values[k + 4] += w * b[k];
            }
        }
    }
    if (guard.x < 1.0) {
        let old = terrainMacroDirect_d(dir, seed, profile);
        values[0] = dMix(old.regional.landMask, values[0], guard);
        values[1] = dMix(old.regional.terrainType, values[1], guard);
        values[2] = dMix(old.regional.ruggedness, values[2], guard);
        values[3] = dMix(old.regional.baseElevation, values[3], guard);
        values[4] = dMix(old.regional.tectonicActivity, values[4], guard);
        // Use the un-gated natural region in the guard too. Gating is below.
        let region = landRegions_d(dir, seed, old.regional);
        values[5] = dMix(region.coord, values[5], guard);
        values[6] = dMix(region.height, values[6], guard);
        values[7] = dMix(region.rough, values[7], guard);
    }
    var out: TerrainMacroD;
    out.regional.isLand = values[0].x > select(0.32, 0.4, smallPlanetMode());
    out.regional.landMask = values[0];
    out.regional.terrainType = values[1];
    out.regional.ruggedness = values[2];
    out.regional.baseElevation = values[3];
    out.regional.tectonicActivity = values[4];
    out.region.coord = dConst(REGION_HIGHLAND_START);
    out.region.height = dConst(0.0);
    out.region.rough = dConst(1.0);
    if (terrainFeatureOn(TF_LAND_REGIONS)) {
        out.region.coord = values[5];
        out.region.height = values[6];
        out.region.rough = values[7];
    }
    return out;
}
`;
}

export function createRegionalTerrainBakeWgsl() {
    return `
struct RegionalBakeParams { face: u32, cells: u32, _pad: vec2<u32>, }
@group(0) @binding(6) var<uniform> regionalBake: RegionalBakeParams;
@group(0) @binding(7) var regionalBakeA: texture_storage_2d<rgba32float, write>;
@group(0) @binding(8) var regionalBakeB: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn regionalBakeMain(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(regionalBake.cells + 3u))) { return; }
    // Nodes, with one extra control before and two after the interior.
    // Always evaluate the analytic source, never already interpolated data.
    let uv = (vec2<f32>(id.xy) - 1.0) / f32(regionalBake.cells);
    let dir = getSpherePoint(i32(regionalBake.face), uv.x, uv.y);
    let regional = getRegionalCharacter_d(dir, uniforms.seed, getTerrainProfile());
    let region = landRegions_d(dir, uniforms.seed, regional);
    textureStore(regionalBakeA, vec2<i32>(id.xy), vec4<f32>(regional.landMask.x,
        regional.terrainType.x, regional.ruggedness.x, regional.baseElevation.x));
    textureStore(regionalBakeB, vec2<i32>(id.xy), vec4<f32>(regional.tectonicActivity.x,
        region.coord.x, region.height.x, region.rough.x));
}

`;
}

export function createRegionalTerrainBoundsWgsl(budgets, seamCells) {
    const n = value => Number(value).toFixed(9);
    return `
@group(0) @binding(9) var regionalBoundsA: texture_2d<f32>;
@group(0) @binding(10) var regionalBoundsB: texture_2d<f32>;
@group(0) @binding(11) var regionalBoundsOut: texture_storage_2d<r32float, write>;

fn regionalNaturalLower(foundationMin: f32, fullyLand: bool, mesoM: f32, hollowM: f32) -> f32 {
    let maxH = maxTerrainHeightM();
    let land = foundationMin + ${n(budgets.reliefErosionLowerM)} - mesoM - hollowM;
    // Ocean FBM: |.05*n500 + .02*n100 + .005*n20| <= .15.
    let ocean = (uniforms.waterParams.y - 0.6 - 0.15) * maxH;
    let mixed = select(min(land, ocean), land, fullyLand);
    let base = softClampHeight(mixed / maxH, -1.1, 1.8, 0.25);
    return softClampHeight(base - ${n(budgets.microM)} / maxH, -1.1, 1.8, 0.25) * maxH
        - ${n(budgets.numericalAllowanceM)};
}

@compute @workgroup_size(8, 8)
fn regionalBoundsMain(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(regionalBake.cells))) { return; }
    let cell = vec2<i32>(id.xy);
    let maxH = maxTerrainHeightM();
    let shelf = select(0.0, 0.14 * getTerrainProfile().baseBias * maxH, terrainFeatureOn(TF_CONTINENT_RELIEF));
    var foundation = 1e30;
    var maskMin = 1.0;
    var roughMax = 0.0;
    var coordMax = -1e30;
    var terrainTypeMax = -1e30;
    var ruggednessMax = -1e30;
    for (var j = 0; j < 4; j++) {
        for (var i = 0; i < 4; i++) {
            let a = textureLoad(regionalBoundsA, cell + vec2<i32>(i, j), 0);
            let b = textureLoad(regionalBoundsB, cell + vec2<i32>(i, j), 0);
            let regionHeight = select(0.0, b.z * maxH, terrainFeatureOn(TF_LAND_REGIONS));
            foundation = min(foundation, a.w * shelf + regionHeight);
            maskMin = min(maskMin, a.x);
            roughMax = max(roughMax, select(1.0, b.w, terrainFeatureOn(TF_LAND_REGIONS)));
            coordMax = max(coordMax, select(REGION_HIGHLAND_START, b.y, terrainFeatureOn(TF_LAND_REGIONS)));
            terrainTypeMax = max(terrainTypeMax, a.y);
            ruggednessMax = max(ruggednessMax, a.z);
        }
    }
    // Convex macro interpolation encloses these modulation values as well.
    // smoothMax(a,b,k) <= max(a,b)+k/4. Detail's other patch factors <= 1.
    let mesoRoughMax = max(terrainTypeMax, ruggednessMax * 0.5) + 0.005;
    let mesoMax = ${n(budgets.mesoM)} * roughMax * smoothstep(0.05, 0.40, mesoRoughMax);
    let hollowT = clamp(coordMax / LAKE_BASIN_RISE, 0.0, 1.0);
    let hollowMax = ${n(budgets.lakeHollowM)} * hollowT*hollowT*hollowT * (hollowT * (hollowT * 6.0 - 15.0) + 10.0);
    var lower = regionalNaturalLower(foundation, maskMin >= 0.45, mesoMax, hollowMax);
    if (uniforms.riverAnchor.w > 0.5 && (terrainFeatureOn(TF_RIVER_CARVE) || terrainFeatureOn(TF_EROSION_SEEDS))) {
        // Legacy demo edits have arbitrary confirmed depth scales. The
        // existing final soft clamp remains a safe but deliberately loose
        // fallback; never advertise the regional proof for those edits.
        lower = -1.1 * maxH - ${n(budgets.numericalAllowanceM)};
    }
    if (any(vec2<f32>(id.xy) < vec2<f32>(${n(seamCells)}))
        || any(vec2<f32>(id.xy + 1u) > vec2<f32>(f32(regionalBake.cells) - ${n(seamCells)}))) {
        // The guard includes direct analytic values not covered by sampled
        // controls. Its contract uses the analytic global foundation bound:
        // small planet baseElevation >= -.8; other planets >= 0.
        let globalFoundation = select(0.0, -0.8 * shelf, smallPlanetMode());
        lower = min(lower, regionalNaturalLower(globalFoundation, false, ${n(budgets.mesoM)}, ${n(budgets.lakeHollowM)}));
    }
    textureStore(regionalBoundsOut, cell, vec4<f32>(lower, 0.0, 0.0, 0.0));
}
`;
}
