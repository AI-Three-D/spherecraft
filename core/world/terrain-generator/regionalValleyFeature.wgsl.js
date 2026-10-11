// One generation-owned valley recipe. Its bounded residual includes the
// original erosion/meso/feature result; material micro is bounded separately.
// A dry valley and its potential lake share this descriptor and geometry.
export function createRegionalValleyFeatureWgsl(enabled=false) {
    if(!enabled) return `
fn regionalValleyApply_d(h: vec4<f32>, dir: vec3<f32>, foundation: TerrainMacroD) -> vec4<f32> { return h; }
fn regionalValleyMicro(h: f32, dir: vec3<f32>) -> f32 { return h; }
`;
    return `
struct RegionalValleyFeature {
    centreLength: vec4<f32>, axisWidth: vec4<f32>, heightBudget: vec4<f32>,
    hills: vec4<f32>, lake: vec4<f32>, climate: vec4<f32>,
}
@group(2) @binding(4) var<storage, read> regionalValleyFeatures: array<RegionalValleyFeature>;
fn regionalValleyPosition_d(f: RegionalValleyFeature, dir: vec3<f32>) -> BasinLocal {
    let c=f.centreLength.xyz; let den=dot(dir,c);
    let axis=f.axisWidth.xyz; let side=normalize(cross(c,axis));
    let a=dot(dir,axis); let b=dot(dir,side); let R=noiseReferenceRadiusM();
    return BasinLocal(vec4<f32>(a/den,(axis/den-c*a/(den*den)))*R/f.centreLength.w,
        vec4<f32>(b/den,(side/den-c*b/(den*den)))*R/f.axisWidth.w);
}
fn regionalValleyWeight_d(p: BasinLocal) -> vec4<f32> {
    let q=dMul(p.u,p.u)+dMul(p.v,p.v);
    return dConst(1.0)-dQuintic(dClamp((q-dConst(0.16))/0.84,0.0,1.0));
}
fn regionalValleyHill_d(u: vec4<f32>, v: vec4<f32>) -> vec4<f32> {
    let q=dMul(u,u)+dMul(v,v);
    let a=dClamp(dConst(1.0)-q,0.0,1.0);
    return dMul(dMul(a,a),a);
}
fn regionalValleyApply_d(height: vec4<f32>, dir: vec3<f32>, foundation: TerrainMacroD) -> vec4<f32> {
    var h=height;
    for(var i=0u;i<u32(regionalTerrainParams._pad);i++) {
        let f=regionalValleyFeatures[i];let den=dot(dir,f.centreLength.xyz);
        if(den<=0.0) { continue; }
        let p=regionalValleyPosition_d(f,dir);let w=regionalValleyWeight_d(p);
        if(w.x<=0.0) { continue; }
        let amp=getTerrainAmplitudes(getTerrainProfile());
        var naturalFoundation=select(dConst(0.0),foundation.regional.baseElevation*amp.continentalShelf,terrainFeatureOn(TF_CONTINENT_RELIEF));
        if(terrainFeatureOn(TF_LAND_REGIONS)) { naturalFoundation+=foundation.region.height; }
        if(terrainFeatureOn(TF_INLAND_UPLIFT)) { naturalFoundation+=dSmoothstep(0.55,0.85,foundation.regional.landMask)*(amp.microGain+0.005); }
        let residual=dTanh((height-naturalFoundation)*maxTerrainHeightM()/f.heightBudget.z)*f.heightBudget.z;
        let hills=regionalValleyHill_d((p.u-dConst(f.hills.z))/0.65,(p.v-dConst(0.60))/0.30)*f.hills.x
            +regionalValleyHill_d((p.u-dConst(f.hills.w))/0.70,(p.v+dConst(0.60))/0.32)*f.hills.y
            +regionalValleyHill_d((p.u-dConst(0.62))/0.25,(p.v-dConst(0.05))/0.68)*(f.hills.x+f.hills.y)*0.4;
        let basin=regionalBasins[0];let local=regionalBasinLocal_d(basin,dir);
        let r2=dMul(local.u,local.u)+dMul(local.v,local.v);
        let depression=regionalBasinWeight_d(basin,local,r2)*f.heightBudget.y;
        let recipeHeight=(dConst(f.heightBudget.x)+hills+dMul(p.u,p.u)*6.0-depression+residual)/maxTerrainHeightM();
        h=dMix(h,recipeHeight,w);
    }
    return h;
}
fn regionalValleyMicro(height: f32, dir: vec3<f32>) -> f32 {
    var h=height;
    for(var i=0u;i<u32(regionalTerrainParams._pad);i++) {
        let f=regionalValleyFeatures[i];if(dot(dir,f.centreLength.xyz)<=0.0) { continue; }
        let w=regionalValleyWeight_d(regionalValleyPosition_d(f,dir)).x;
        if(w<=0.0) { continue; }
        let limit=f.heightBudget.w/maxTerrainHeightM();
        h=mix(h,tanh(h/limit)*limit,w);
    }
    return h;
}
`;
}

// Only macro inputs, climate, and existing coarse bounds are evaluated once.
// The fixed feature address is the recipe's site; no terrain-height search.
export function createRegionalValleyAnchorWgsl() {
    return `
@group(0) @binding(6) var<uniform> valleySeedSite: vec4<f32>;
@group(0) @binding(7) var<storage, read_write> valleySeedOutput: vec4<f32>;
@group(0) @binding(8) var valleySeedBounds: texture_2d_array<f32>;
fn valleySeedRatio(num: f32, den: f32, rho: f32) -> vec2<f32> {
    let a=vec2<f32>((num-rho)/(den-rho),(num-rho)/(den+rho));
    let b=vec2<f32>((num+rho)/(den-rho),(num+rho)/(den+rho));
    return vec2<f32>(min(min(a.x,a.y),min(b.x,b.y)),max(max(a.x,a.y),max(b.x,b.y)))*0.5+0.5;
}
@compute @workgroup_size(1)
fn regionalValleyAnchorMain() {
    let c=valleySeedSite.xyz;let rho=valleySeedSite.w/noiseReferenceRadiusM()+0.000002;
    let fp=mtnFacePos(c);let N=regionalTerrainParams.cells;
    let normal=mtnCubePoint(fp.face,0.0,0.0);
    let den=dot(c,normal);
    let u=dot(c,mtnCubePoint(fp.face,1.0,0.0)-normal);
    let v=dot(c,mtnCubePoint(fp.face,0.0,1.0)-normal);
    let ur=valleySeedRatio(u,den,rho);let vr=valleySeedRatio(v,den,rho);
    let lo=vec2<f32>(ur.x,vr.x)*N;let hi=vec2<f32>(ur.y,vr.y)*N;
    if(any(lo<vec2<f32>(regionalTerrainParams.seamCells))
        ||any(hi+vec2<f32>(1.0)>vec2<f32>(N-regionalTerrainParams.seamCells))) {
        valleySeedOutput=vec4<f32>(0.0,0.0,0.0,1e20);return;
    }
    var mask=1.0;var lower=-1e20;
    for(var y=i32(floor(lo.y));y<=i32(floor(hi.y));y++) {
        for(var x=i32(floor(lo.x));x<=i32(floor(hi.x));x++) {
            lower=max(lower,textureLoad(valleySeedBounds,vec2<i32>(x,y),fp.face,0).x);
            for(var j=0;j<4;j++) { for(var i=0;i<4;i++) {
                mask=min(mask,textureLoad(regionalMacroA,vec2<i32>(x+i,y+j),fp.face,0).x);
            } }
        }
    }
    let profile=getTerrainProfile();let amp=getTerrainAmplitudes(profile);
    let coarse=terrainMacro_d(c,uniforms.seed,profile);
    var anchor=select(0.0,coarse.regional.baseElevation.x*amp.continentalShelf*maxTerrainHeightM(),terrainFeatureOn(TF_CONTINENT_RELIEF));
    if(terrainFeatureOn(TF_LAND_REGIONS)) { anchor+=coarse.region.height.x*maxTerrainHeightM(); }
    if(terrainFeatureOn(TF_INLAND_UPLIFT)) { anchor+=smoothstep(0.55,0.85,coarse.regional.landMask.x)*(amp.microGain+0.005)*maxTerrainHeightM(); }
    let climate=getClimate(c.x,c.z,c,anchor/maxTerrainHeightM(),uniforms.seed);
    valleySeedOutput=vec4<f32>(anchor,climate.precipitation,mask,lower);
}
`;
}
