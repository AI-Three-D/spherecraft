// Planning-only intervals over the EXISTING terrain equations. These do not
// replace noise, alter erosion, or enter the per-texel terrain workload.
export function createRegionalBasinCertificateWgsl(ef, budgets, { slopeAware = false } = {}) {
    if (ef.variationMin > 1) throw new Error('Basin certificate currently requires erosion variationMin <= 1');
    if(slopeAware&&(!Number.isFinite(ef.sharpSlopeStart)||ef.sharpSlopeStart<0||!Number.isFinite(ef.sharpSlopeFull)||ef.sharpSlopeFull<=ef.sharpSlopeStart)) throw new Error('Invalid continuous erosion slope ramp');
    const n = v => Number(v).toFixed(9);
    return `
struct BasinCandidate { centreRadius: vec4<f32>, }
@group(0) @binding(6) var<storage, read> basinCandidates: array<BasinCandidate>;
@group(0) @binding(7) var<storage, read_write> basinCertificates: array<vec4<f32>>;

fn intervalMix(a: vec2<f32>, b: vec2<f32>, t: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(min(mix(a.x,b.x,t.x),mix(a.x,b.x,t.y)),
        max(mix(a.y,b.y,t.x),mix(a.y,b.y,t.y)));
}
// Exact linear corner envelopes and monotone fade intervals, joined across
// every intersected lattice cell. The universal 79/64 envelope is proved in
// structuredBasinBoundAudit.mjs; it also bounds wide boxes, not just samples.
fn perlinBox(lo: vec3<f32>, hi: vec3<f32>, seed: i32) -> vec2<f32> {
    let first = vec3<i32>(floor(lo));
    let last = vec3<i32>(floor(hi));
    if (any(last-first > vec3<i32>(1))) { return vec2<f32>(-1.234475,1.234475); }
    var result = vec2<f32>(2.0,-2.0);
    for (var z=first.z;z<=last.z;z++) { for (var y=first.y;y<=last.y;y++) { for (var x=first.x;x<=last.x;x++) {
        let cell = vec3<i32>(x,y,z);
        let a = clamp(lo-vec3<f32>(cell),vec3<f32>(0.0),vec3<f32>(1.0));
        let b = clamp(hi-vec3<f32>(cell),vec3<f32>(0.0),vec3<f32>(1.0));
        var corners: array<vec2<f32>,8>;
        for (var k=0u;k<8u;k++) {
            let offset = vec3<i32>(i32(k&1u),i32((k>>1u)&1u),i32((k>>2u)&1u));
            let g = grad3vec(hash3d(cell+offset,seed));
            let ca = a-vec3<f32>(offset); let cb = b-vec3<f32>(offset);
            let low = select(cb,ca,g>=vec3<f32>(0.0));
            let high = select(ca,cb,g>=vec3<f32>(0.0));
            corners[k] = vec2<f32>(dot(g,low),dot(g,high));
        }
        let tx = vec2<f32>(fade(a.x),fade(b.x));
        let ty = vec2<f32>(fade(a.y),fade(b.y));
        let tz = vec2<f32>(fade(a.z),fade(b.z));
        let v = intervalMix(intervalMix(intervalMix(corners[0],corners[1],tx),intervalMix(corners[2],corners[3],tx),ty),
            intervalMix(intervalMix(corners[4],corners[5],tx),intervalMix(corners[6],corners[7],tx),ty),tz);
        result = vec2<f32>(min(result.x,v.x),max(result.y,v.y));
    } } }
    return clamp(result,vec2<f32>(-1.234375),vec2<f32>(1.234375)) + vec2<f32>(-0.0001,0.0001);
}
fn basinNoiseBox(c: vec3<f32>, rho: f32, scaleKm: f32, octaves: i32, seed: i32) -> vec2<f32> {
    let factor = noiseReferenceRadiusM()/wavelength_m(scaleKm,GEOLOGY_SCALE);
    let p = rotateDomain3(c*factor);
    // Rotation is orthonormal. A chord ball is inside this axis-aligned box.
    var value = vec2<f32>(0.0); var sum = 0.0; var amp = 1.0; var freq = 1.0;
    for(var i=0;i<octaves;i++) {
        let width = vec3<f32>(rho*factor*freq+0.0001);
        value += perlinBox(p*freq-width,p*freq+width,seed+i)*amp;
        sum += amp; amp *= 0.5; freq *= 2.0;
    }
    return value/sum;
}
// microFbmAuto rotates the position between octaves. The chord ball remains
// a ball under that rotation, so the same conservative box construction works.
fn basinMicroNoiseBox(c: vec3<f32>, rho: f32, scaleKm: f32, octaves: i32, seed: i32) -> vec2<f32> {
    let factor = noiseReferenceRadiusM()/wavelength_m(scaleKm,GEOLOGY_SCALE);
    var p = rotateDomain3(c*factor);
    var value = vec2<f32>(0.0); var sum = 0.0; var amp = 1.0; var freq = 1.0;
    for(var i=0;i<octaves;i++) {
        let width = vec3<f32>(rho*factor*freq+0.0001);
        value += perlinBox(p*freq-width,p*freq+width,seed+i)*amp;
        sum += amp; amp *= 0.5; freq *= 2.0;
        p = vec3<f32>(0.36*p.x+0.48*p.y-0.80*p.z,-0.80*p.x+0.60*p.y,0.48*p.x+0.64*p.y+0.60*p.z);
    }
    return value/sum;
}
fn basinMicroAllowance(c: vec3<f32>, rho: f32) -> f32 {
    let b = 1.234475;
    let a = basinMicroNoiseBox(c,rho,2.0,2,uniforms.seed+9300);
    let bm = basinMicroNoiseBox(c,rho,8.0,2,uniforms.seed+9310);
    let modulation = mix(0.35,1.0,smoothstep(-0.3,0.3,a.y))*mix(0.50,1.0,smoothstep(-0.2,0.2,bm.y));
    // Forest's selector adds 200 to the seed. Bound its broad intensity and
    // flavors, while leaving short detail at the universal noise envelope.
    let ia = basinMicroNoiseBox(c,rho,2.0,3,uniforms.seed+9000);
    let ib = basinMicroNoiseBox(c,rho,5.0,2,uniforms.seed+9050);
    let intensity = mix(0.08,1.0,smoothstep(-0.25,0.35,ia.y))*mix(0.3,1.0,smoothstep(-0.10,0.40,ib.y));
    let pa = basinMicroNoiseBox(c,rho,SCALE_MICRO_500,2,uniforms.seed+9400);
    let rc = basinMicroNoiseBox(c,rho,10.0,3,uniforms.seed+9500);
    let rc2 = basinMicroNoiseBox(c,rho,80.0,2,uniforms.seed+9550);
    let forest = b*(0.9*smoothstep(-0.2,0.2,pa.y)+0.2*smoothstep(-0.3,0.05,rc.y)
        +0.12*smoothstep(0.05,0.35,rc2.y))*intensity*DISP_MICRO_FOREST;
    let grass = b*0.7625*DISP_MICRO_GRASS;
    // The sand dune multiplier may exceed one. Include that overshoot and
    // the largest displacement, independently of slope/material selection.
    let sand = max((0.65*b+0.25)*(0.5*b+0.5),b)*max(DISP_MICRO_SAND_FLAT,DISP_MICRO_SAND_STEEP);
    let generic = 0.5*b*DISP_MICRO_GENERIC;
    return max(max(forest,grass),max(sand,generic))*modulation*clamp(getTerrainProfile().microGain,0.0,5.0);
}
fn basinRatioBox(num: f32, den: f32, rho: f32) -> vec2<f32> {
    let a = vec2<f32>((num-rho)/(den-rho),(num-rho)/(den+rho));
    let b = vec2<f32>((num+rho)/(den-rho),(num+rho)/(den+rho));
    return vec2<f32>(min(min(a.x,a.y),min(b.x,b.y)),max(max(a.x,a.y),max(b.x,b.y)))*0.5+0.5;
}
fn basinInsideMtnCell(site: MtnSite, uvLo: vec2<f32>, uvHi: vec2<f32>) -> bool {
    return all(uvLo>=vec2<f32>(site.x0,site.y0)) && all(uvHi<=vec2<f32>(site.x1,site.y1));
}
// Prove absence from the existing hard footprint guards, using the same
// deterministic placement. No mountain profile/height is replaced or baked.
fn basinMassifAbsent(c: vec3<f32>, rho: f32, site: MtnSite, uvLo: vec2<f32>, uvHi: vec2<f32>, rMin: f32, rMax: f32) -> bool {
    if(!basinInsideMtnCell(site,uvLo,uvHi)) { return false; }
    if(!site.ok) { return true; }
    var h=site.h;
    _ = mtnRand(&h); // existing height draw precedes the radius draw
    let r=mix(rMin,rMax,mtnRand(&h));
    let angle=1.8*r/noiseReferenceRadiusM();
    let placed=mtnPlace(site,&h,angle);
    return !placed.ok || dot(c,placed.c)+rho+0.000001<cos(angle);
}
fn basinRangeAbsent(c: vec3<f32>, rho: f32, site: MtnSite, uvLo: vec2<f32>, uvHi: vec2<f32>) -> bool {
    if(!basinInsideMtnCell(site,uvLo,uvHi)) { return false; }
    if(!site.ok) { return true; }
    var h=site.h;
    let L=mix(MTN_RANGE_LEN_MIN,MTN_RANGE_LEN_MAX,mtnRand(&h));
    let W=mix(MTN_RANGE_HALF_W_MIN,MTN_RANGE_HALF_W_MAX,mtnRand(&h));
    _ = mtnRand(&h);
    let bend=(mtnRand(&h)-0.5)*0.5*L;
    let wig=(mtnRand(&h)-0.5)*0.12*L;
    let maxSlope=(4.0*abs(bend)+9.43*abs(wig))/L;
    let lateral=abs(bend)+abs(wig)+2.75*W*sqrt(1.0+maxSlope*maxSlope)+0.1*W;
    let angle=sqrt(0.25*L*L+lateral*lateral)/noiseReferenceRadiusM();
    let placed=mtnPlace(site,&h,angle);
    return !placed.ok || dot(c,placed.c)+rho+0.000001<cos(angle);
}
fn basinReliefAbsent(c: vec3<f32>, rho: f32, fp: MtnFacePos, uvLo: vec2<f32>, uvHi: vec2<f32>, ttMax: f32) -> bool {
    if(terrainFeatureOn(TF_FOOTHILLS) && ttMax>FOOTHILL_TT_START) { return false; }
    if(terrainFeatureOn(TF_LONE_HILLS_VERY_RARE)) {
        let n=basinNoiseBox(c,rho,SCALE_LONE_HILL_HUGE,1,uniforms.seed+4400);
        if(n.y>0.28) { return false; }
    }
    if(terrainFeatureOn(TF_LONE_HILLS_LANDMARK)) {
        let a=basinNoiseBox(c,rho,SCALE_LONE_HILL_LANDMARK,1,uniforms.seed+4500);
        let b=basinNoiseBox(c,rho,SCALE_LONE_HILL_LANDMARK,1,uniforms.seed+4501);
        if(max(a.y,b.y)+0.0075>0.34) { return false; }
    }
    if(terrainFeatureOn(TF_MOUNTAINS) && !basinMassifAbsent(c,rho,
        mtnSite(fp,MTN_CELL_M,MTN_DENSITY_PER_KM2*1e-6,0x68bc21ebu),uvLo,uvHi,MTN_R_MIN,MTN_R_MAX)) { return false; }
    if(terrainFeatureOn(TF_MOUNTAIN_LANDMARK) && !basinMassifAbsent(c,rho,
        mtnSite(fp,MTN_LANDMARK_CELL_M,MTN_LANDMARK_DENSITY_PER_KM2*1e-6,0x02e5be93u),uvLo,uvHi,MTN_LANDMARK_R_MIN,MTN_LANDMARK_R_MAX)) { return false; }
    if(terrainFeatureOn(TF_MOUNTAIN_RANGE) && !basinRangeAbsent(c,rho,
        mtnSite(fp,MTN_RANGE_CELL_M,MTN_RANGE_DENSITY_PER_KM2*1e-6,0x967a889bu),uvLo,uvHi)) { return false; }
    return true;
}

@compute @workgroup_size(1)
fn basinCertificateMain(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x>=arrayLength(&basinCandidates)) { return; }
    let candidate = basinCandidates[id.x].centreRadius;
    let c = candidate.xyz;
    // radius is a tangent-plane footprint radius. Chord displacement <= r/R.
    let rho = candidate.w/noiseReferenceRadiusM()+0.000002;
    let fp = mtnFacePos(c);
    let normal = mtnCubePoint(fp.face,0.0,0.0);
    let axisU = mtnCubePoint(fp.face,1.0,0.0)-normal;
    let axisV = mtnCubePoint(fp.face,0.0,1.0)-normal;
    let den = dot(c,normal);
    let ub = basinRatioBox(dot(c,axisU),den,rho)*regionalTerrainParams.cells;
    let vb = basinRatioBox(dot(c,axisV),den,rho)*regionalTerrainParams.cells;
    let cell = vec2<i32>(floor(vec2<f32>(ub.x,vb.x)));
    // First prototype certificates deliberately stay in one non-seam cell.
    if (any(cell != vec2<i32>(floor(vec2<f32>(ub.y,vb.y))))
        || any(vec2<f32>(cell)<vec2<f32>(regionalTerrainParams.seamCells))
        || any(vec2<f32>(cell+1)>vec2<f32>(regionalTerrainParams.cells-regionalTerrainParams.seamCells))) {
        basinCertificates[id.x] = vec4<f32>(-1e20,0.0,0.0,0.0); return;
    }
    let wa = regionalSpline(ub.x-f32(cell.x)); let wb = regionalSpline(ub.y-f32(cell.x));
    let va = regionalSpline(vb.x-f32(cell.y)); let vbb = regionalSpline(vb.y-f32(cell.y));
    let maxH = maxTerrainHeightM();
    let shelf = select(0.0,0.14*getTerrainProfile().baseBias*maxH,terrainFeatureOn(TF_CONTINENT_RELIEF));
    let refA = textureLoad(regionalMacroA,cell+vec2<i32>(1),fp.face,0);
    let refB = textureLoad(regionalMacroB,cell+vec2<i32>(1),fp.face,0);
    let reference = refA.w*shelf + select(0.0,refB.z*maxH,terrainFeatureOn(TF_LAND_REGIONS));
    var foundation = reference; var rough = 0.0; var tt = 0.0; var rug = 0.0; var coord = 0.0; var mask = 1.0;
    var controls: array<f32,16>;
    for(var j=0;j<4;j++) { for(var i=0;i<4;i++) {
        let a = textureLoad(regionalMacroA,cell+vec2<i32>(i,j),fp.face,0);
        let b = textureLoad(regionalMacroB,cell+vec2<i32>(i,j),fp.face,0);
        let delta = a.w*shelf + select(0.0,b.z*maxH,terrainFeatureOn(TF_LAND_REGIONS))-reference;
        controls[j*4+i]=delta;
        let weightLo = min(wa[i],wb[i])*min(va[j],vbb[j]);
        let weightHi = max(wa[i],wb[i])*max(va[j],vbb[j]);
        foundation += delta*select(weightHi,weightLo,delta>=0.0);
        rough = max(rough,select(1.0,b.w,terrainFeatureOn(TF_LAND_REGIONS)));
        coord = max(coord,select(REGION_HIGHLAND_START,b.y,terrainFeatureOn(TF_LAND_REGIONS)));
        tt=max(tt,a.y); rug=max(rug,a.z); mask=min(mask,a.x);
    } }
    if(mask<0.45 || uniforms.riverAnchor.w>0.5) { basinCertificates[id.x]=vec4<f32>(-1e20,0.0,0.0,0.0); return; }
    let vn = basinNoiseBox(c,rho,${n(ef.variationScaleM/1000)},3,uniforms.seed+7100);
    let variation = ${n(ef.variationMin)} + smoothstep(-0.35,0.35,vn.y)*(1.0-${n(ef.variationMin)});
    let sn = basinNoiseBox(c,rho,${n(ef.styleScaleM/1000)},3,uniforms.seed+7300);
    let st = smoothstep(vec2<f32>(-0.15),vec2<f32>(0.15),sn+vec2<f32>(${n(ef.styleBias)}));
    let strengths = vec2<f32>(${n(ef.styleStrength[0])})+st*${n(ef.styleStrength[1]-ef.styleStrength[0])};
    let styleMax = max(strengths.x,strengths.y);
    let erosionA = ${n(ef.strength*ef.scale*ef.gullyWeight*budgets.octaveSum)}*styleMax;
    // Interval minimization of relief minus erosion, including mountain's
    // variation floor. Mountain height <= total positive relief. Subdivision
    // only affects certificate tightness, never the generated landforms.
    var coupled = 0.0;
    let upperR = max(max(erosionA*max(1.0,${n(ef.lowReliefAmount)})*max(1.0,variation),${n(ef.reliefFullM)}),MTN_EROSION_FULL_M);
    for(var i=0;i<256;i++) {
        let lo = upperR*f32(i)/256.0; let hi = upperR*f32(i+1)/256.0;
        let floorT = clamp((hi-MTN_EROSION_START_M)/(MTN_EROSION_FULL_M-MTN_EROSION_START_M),0.0,1.0);
        let floorMax = fade(floorT);
        let variationMax = max(variation,variation+(1.0-variation)*floorMax);
        let a0 = mix(${n(ef.lowReliefAmount)},1.0,smoothstep(${n(ef.reliefStartM)},${n(ef.reliefFullM)},lo));
        let a1 = mix(${n(ef.lowReliefAmount)},1.0,smoothstep(${n(ef.reliefStartM)},${n(ef.reliefFullM)},hi));
        coupled = min(coupled,lo-erosionA*variationMax*max(a0,a1));
    }
    // A cubic spline derivative is a convex sum of neighbouring control
    // differences. Bound the gnomonic chain rule by triangle inequality.
    // Only replace the allowance if ALL eroded relief is proved absent and
    // the entire foundation slope lies below the existing zero-erosion onset.
    var dx=0.0; var dy=0.0;
    for(var j=0;j<4;j++) { for(var i=0;i<3;i++) {
        dx=max(dx,abs(controls[j*4+i+1]-controls[j*4+i]));
        dy=max(dy,abs(controls[(i+1)*4+j]-controls[i*4+j]));
    } }
    let uvLo=vec2<f32>(ub.x,vb.x)/regionalTerrainParams.cells*2.0-1.0;
    let uvHi=vec2<f32>(ub.y,vb.y)/regionalTerrainParams.cells*2.0-1.0;
    let maxU=max(abs(uvLo.x),abs(uvHi.x)); let maxV=max(abs(uvLo.y),abs(uvHi.y));
    let slopeMax=(dx*sqrt(1.0+maxU*maxU)+dy*sqrt(1.0+maxV*maxV))*regionalTerrainParams.cells
        /(2.0*(den-rho)*noiseReferenceRadiusM())+0.0001;
    if(slopeMax<${n(ef.sharpSlopeStart)} && basinReliefAbsent(c,rho,fp,uvLo,uvHi,tt)) { coupled=0.0; }
    ${slopeAware ? `
    // Where all eroded relief is PROVED absent, the entire input landform
    // is the foundation spline. Use its continuous slope bound in the SAME
    // erosion amount ramp; no sampled slope/minimum enters this certificate.
    if(basinReliefAbsent(c,rho,fp,uvLo,uvHi,tt)) {
        let steepnessMax=smoothstep(${n(ef.sharpSlopeStart)},${n(ef.sharpSlopeFull)},slopeMax);
        coupled=max(coupled,-erosionA*variation*${n(ef.lowReliefAmount)}*steepnessMax);
    }
    ` : ''}
    let mesoN = basinNoiseBox(c,rho,SCALE_MESO2,3,uniforms.seed+9800);
    let quiet = basinNoiseBox(c,rho,1.5,2,uniforms.seed+9500);
    let region = basinNoiseBox(c,rho,10.0,2,uniforms.seed+9550);
    let mesoAbs = ${ef.mesoKeep >= 0 && ef.mesoKeep <= 1 && budgets.maxAmount*(1-ef.mesoKeep) <= 1
        ? 'max(0.0,-mesoN.x)' : 'max(abs(mesoN.x),abs(mesoN.y))'};
    let meso = ${n(budgets.mesoM/budgets.noiseBound)}*mesoAbs*rough*smoothstep(0.05,0.40,max(tt,0.5*rug)+0.005)
        *mix(0.20,1.0,smoothstep(-0.4,0.2,quiet.y))*mix(0.35,1.0,smoothstep(-0.3,0.3,region.y));
    let hollowN = basinNoiseBox(c,rho,SCALE_LAKE_BASIN,2,uniforms.seed+8200);
    let hollow = ${n(budgets.lakeHollowM)}*fade(clamp(coord/LAKE_BASIN_RISE,0.0,1.0))
        *fade(clamp((hollowN.y-LAKE_BASIN_FROM)/(LAKE_BASIN_FULL-LAKE_BASIN_FROM),0.0,1.0));
    let uplift = select(0.0,smoothstep(0.55,0.85,mask)*(getTerrainAmplitudes(getTerrainProfile()).microGain+0.005)*maxH,
        terrainFeatureOn(TF_INLAND_UPLIFT));
    let lowerBase = softClampHeight((foundation+coupled-meso-hollow+uplift)/maxH,-1.1,1.8,0.25);
    let micro = min(${n(budgets.microM)},basinMicroAllowance(c,rho));
    let lower = softClampHeight(lowerBase-micro/maxH,-1.1,1.8,0.25)*maxH-${n(budgets.numericalAllowanceM)};
    let centreHeight = calculateTerrainHeightBaseD(uniforms.seed,c).x*maxH;
    basinCertificates[id.x] = vec4<f32>(lower,centreHeight,coupled,meso);
}
`;
}
export function createRegionalRouteHeightWgsl({source='natural',shape=false}={}) {
    const height=source==='foundation'?`
    let profile=getTerrainProfile();let amp=getTerrainAmplitudes(profile);
    let m=terrainMacro_d(c,uniforms.seed,profile);
    var h=select(dConst(0.0),m.regional.baseElevation*amp.continentalShelf,terrainFeatureOn(TF_CONTINENT_RELIEF));
    if(terrainFeatureOn(TF_LAND_REGIONS)) { h+=m.region.height; }
    if(terrainFeatureOn(TF_INLAND_UPLIFT)) { h+=dSmoothstep(0.55,0.85,m.regional.landMask)*(amp.microGain+0.005); }
    h=dMix(dConst(uniforms.waterParams.y+amp.oceanDepth),h,dSmoothstep(0.15,0.45,m.regional.landMask));
    h=softClampHeight_d(h,-1.1,1.8,0.25);
    ${shape?'let s=regionalShapeSample_d(c);h=dMix(h,s.height,s.weight);':''}
    let heightM=h.x*maxTerrainHeightM();
    `:'let heightM=calculateTerrainHeightBaseD(uniforms.seed,c).x*maxTerrainHeightM();';
    return `
@compute @workgroup_size(64)
fn regionalRouteHeightMain(@builtin(global_invocation_id) id: vec3<u32>) {
    if(id.x>=arrayLength(&basinCandidates)) { return; }
    let c=basinCandidates[id.x].centreRadius.xyz;
    ${height}
    basinCertificates[id.x]=vec4<f32>(heightM,0.0,0.0,0.0);
}

`;
}

// Placement evidence derived from the existing landform. It ranks regions;
// these values are never used as continuous lower bounds.
export function createRegionalPlacementSurveyWgsl() {
    return `
@compute @workgroup_size(64)
fn regionalPlacementSurveyMain(@builtin(global_invocation_id) id: vec3<u32>) {
    if(id.x>=arrayLength(&basinCandidates)) { return; }
    let c=basinCandidates[id.x].centreRadius.xyz;
    let profile=getTerrainProfile();let amp=getTerrainAmplitudes(profile);
    let coarseInput=terrainMacro_d(c,uniforms.seed,profile);
    var foundation=select(dConst(0.0),coarseInput.regional.baseElevation*amp.continentalShelf,terrainFeatureOn(TF_CONTINENT_RELIEF));
    if(terrainFeatureOn(TF_LAND_REGIONS)) { foundation+=coarseInput.region.height; }
    var foot=dConst(0.0);
    if(terrainFeatureOn(TF_FOOTHILLS)) {
        let band=dSmoothstep(FOOTHILL_TT_START,FOOTHILL_TT_FULL,coarseInput.regional.terrainType);
        if(band.x>0.0) { foot=dMul(band,dSmoothstep(-0.3,0.6,fbmAuto_d(c,SCALE_FOOTHILLS,3,uniforms.seed+1950,2.0,0.5)))
            *((HEIGHT_FOOTHILLS/maxTerrainHeightM())*amp.mountainHeight); }
    }
    let relief=foot+featureBigHillsHeight_d(c,uniforms.seed,amp)+featureMountainsHeight_d(c,uniforms.seed);
    basinCertificates[id.x]=vec4<f32>(calculateTerrainHeightBaseD(uniforms.seed,c).x*maxTerrainHeightM(),
        relief.x*maxTerrainHeightM(),length(terrainSurfaceGradient(foundation+relief,c))*maxTerrainHeightM(),foundation.x*maxTerrainHeightM());
}
`;
}
