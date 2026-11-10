// An authoritative regional terrain input: eroded natural shape in x, packed
// micro-mask control / potential-water cell ownership bits in y. Independent
// of render LOD. The existing analytic stack remains the exterior fallback.
export function createRegionalShapeWgsl() {
    return `
struct RegionalShapeParams {
    address: vec4<f32>, // face, quadtree grid, x, y
    info: vec4<f32>, // cells, C2 edge guard, water enabled, bounded micro fraction
    water: vec4<f32>, // level metres, max bed cut, micro limit, numerical allowance
    limits: vec4<f32>,
}
@group(2) @binding(4) var<uniform> regionalShapeParams: RegionalShapeParams;
@group(2) @binding(5) var regionalShapeField: texture_2d<f32>;
struct RegionalShapeSample { height: vec4<f32>, weight: vec4<f32>, mask: f32, owned: bool, levelM: f32, }
struct RegionalShapeLocation { params: RegionalShapeParams, offset: vec2<i32>, valid: bool, }
fn regionalShapeAtlasTexel(linear: i32) -> vec4<f32> {
    let width=i32(regionalShapeParams.address.z);
    return textureLoad(regionalShapeField,vec2<i32>(linear%width,linear/width),0);
}
fn regionalShapeDirectory(cell: vec2<i32>,face: i32) -> vec4<f32> {
    let grid=i32(regionalShapeParams.address.y);
    return regionalShapeAtlasTexel((face*grid+cell.y)*grid+cell.x);
}
fn regionalShapeLocate(dir: vec3<f32>) -> RegionalShapeLocation {
    var out: RegionalShapeLocation;out.params=regionalShapeParams;out.valid=true;
    if(regionalShapeParams.limits.z!=-2.0) { return out; }
    let fp=mtnFacePos(dir);let p=regionalShapeParams;let grid=i32(p.address.y);
    let uv=vec2<f32>(fp.x,fp.y)*0.5+0.5;
    let cell=clamp(vec2<i32>(floor(uv*f32(grid))),vec2<i32>(0),vec2<i32>(grid-1));
    let id=i32(regionalShapeDirectory(cell,fp.face).x)-1;
    if(id<0||id>=i32(p.limits.y)) { out.valid=false;return out; }
    let record=id*5+i32(p.address.z*p.address.w);
    out.params.address=regionalShapeAtlasTexel(record);
    out.params.info=regionalShapeAtlasTexel(record+1);
    out.params.water=regionalShapeAtlasTexel(record+2);
    out.params.limits=regionalShapeAtlasTexel(record+3);
    out.offset=vec2<i32>(regionalShapeAtlasTexel(record+4).xy);
    return out;
}
fn regionalShapeShoreLevel(dir: vec3<f32>) -> f32 {
    let location=regionalShapeLocate(dir);if(!location.valid) { return -1.0e20; }
    let fp=mtnFacePos(dir);let p=location.params;
    if(fp.face!=i32(p.address.x)) { return -1.0e20; }
    let pos=((vec2<f32>(fp.x,fp.y)*0.5+0.5)*p.address.y-p.address.zw)*p.info.x;
    let extent=select(vec2<f32>(p.info.x),p.limits.xy,p.limits.z<0.0);
    if(any(pos<vec2<f32>(0))||any(pos>=extent)) { return -1.0e20; }
    let tex=textureLoad(regionalShapeField,vec2<i32>(floor(pos))+location.offset,0);
    if(regionalShapeParams.limits.z==-2.0&&tex.w>0.0) { return tex.z; }
    if((u32(tex.y)&2u)!=0u) { return select(p.water.x,tex.z,p.limits.z<0.0); }
    return -1.0e20;
}
fn regionalShapeShoreWeight(dir: vec3<f32>) -> f32 {
    if(regionalShapeParams.limits.z!=-2.0) { return 1.0; }
    let location=regionalShapeLocate(dir);if(!location.valid) { return 0.0; }
    let fp=mtnFacePos(dir);let p=location.params;
    let pos=((vec2<f32>(fp.x,fp.y)*0.5+0.5)*p.address.y-p.address.zw)*p.info.x-vec2<f32>(0.5);
    let cell=vec2<i32>(floor(pos));let t=fract(pos);var coverage=0.0;
    for(var j=0;j<2;j++) { for(var i=0;i<2;i++) {
        let q=clamp(cell+vec2<i32>(i,j),vec2<i32>(0),vec2<i32>(i32(p.info.x)-1));
        let tex=textureLoad(regionalShapeField,q+location.offset,0);
        coverage+=tex.w*select(1.0-t.x,t.x,i==1)*select(1.0-t.y,t.y,j==1);
    } }
    return smoothstep(0.0,0.75,coverage);
}
fn regionalShapeSample_d(dir: vec3<f32>) -> RegionalShapeSample {
    var out: RegionalShapeSample;
    let location=regionalShapeLocate(dir);if(!location.valid) { return out; }
    let fp=mtnFacePos(dir);let p=location.params;
    if(fp.face!=i32(p.address.x)) { return out; }
    let uv=vec2<f32>(fp.x,fp.y)*0.5+0.5;
    let pos=(uv*p.address.y-p.address.zw)*p.info.x;
    var extent=vec2<f32>(p.info.x);
    var local=pos;
    if(p.limits.z<0.0) { extent=p.limits.xy;local=pos-floor(pos/p.info.x)*p.info.x; }
    if(any(pos<vec2<f32>(0.0))||any(pos>=extent)) { return out; }
    let normal=mtnCubePoint(fp.face,0.0,0.0);let den=dot(dir,normal);
    let gu=(mtnCubePoint(fp.face,1.0,0.0)-normal-normal*fp.x)/(2.0*den)*p.address.y*p.info.x;
    let gv=(mtnCubePoint(fp.face,0.0,1.0)-normal-normal*fp.y)/(2.0*den)*p.address.y*p.info.x;
    let edge=min(local,vec2<f32>(p.info.x)-local);
    let u=dQuintic(dClamp(vec4<f32>(edge.x,gu*select(1.0,-1.0,local.x>p.info.x*0.5))/p.info.y,0.0,1.0));
    let v=dQuintic(dClamp(vec4<f32>(edge.y,gv*select(1.0,-1.0,local.y>p.info.x*0.5))/p.info.y,0.0,1.0));
    out.weight=dMul(u,v);
    if(out.weight.x<=0.0) { return out; }
    let cell=vec2<i32>(floor(pos));let t=pos-vec2<f32>(cell);
    let wu=regionalSpline(t.x);let wv=regionalSpline(t.y);
    let du=regionalSplineD(t.x);let dv=regionalSplineD(t.y);
    for(var j=0;j<4;j++) { for(var i=0;i<4;i++) {
        let tex=textureLoad(regionalShapeField,cell+vec2<i32>(i,j)+location.offset,0);
        let w=wu[i]*wv[j];
        out.height+=vec4<f32>(w,gu*du[i]*wv[j]+gv*wu[i]*dv[j])*tex.x/maxTerrainHeightM();
        out.mask+=w*f32(u32(tex.y)&1u);
        if(i==0&&j==0) {
            out.owned=(u32(tex.y)&2u)!=0u;out.levelM=p.water.x;
            if(p.limits.z<0.0) { out.levelM=tex.z; }
        }
    } }
    if(regionalShapeParams.limits.z==-2.0&&out.owned) {
        let delta=out.height*maxTerrainHeightM()-dConst(out.levelM);
        // Vanish before the certified dry retaining ring. Ownership is a
        // cell flag, so detail must be zero where that flag can change.
        if(abs(delta.x)>=0.5) { return out; }
        let band=dConst(1.0)-dQuintic(dClamp((dAbs(delta)-dConst(0.1))/0.4,0.0,1.0));
        let scale=maxTerrainHeightM();
        let q=dir*131072.0;
        let n0=perlin3D_d(q/24.0,7313);let n1=perlin3D_d(q/7.0,9127);
        let detail=vec4<f32>(n0.x,n0.yzw*(131072.0/24.0))*0.17
            +vec4<f32>(n1.x,n1.yzw*(131072.0/7.0))*0.08;
        out.height+=dMul(band,dClamp(detail,-0.25,0.25))/scale;
    }
    return out;
}
fn regionalShapeBasinApply_d(height: vec4<f32>, dir: vec3<f32>) -> vec4<f32> {
    if(regionalShapeParams.info.z<0.5) { return height; }
    let s=regionalShapeSample_d(dir);
    if(!s.owned) { return height; }
    // Only underwater deepening. Across ownership-cell boundaries the
    // independently proved dry ring makes this cut identically zero.
    let wet=dQuintic(dClamp((dConst(s.levelM)-height*maxTerrainHeightM())/regionalShapeParams.limits.w,0.0,1.0));
    return height-wet*(regionalShapeParams.water.y/maxTerrainHeightM());
}
fn regionalShapeMicroKeep(dir: vec3<f32>) -> f32 {
    if(regionalShapeParams.info.z<0.5) { return 1.0; }
    let s=regionalShapeSample_d(dir);
    return mix(1.0,regionalShapeParams.info.w,clamp(s.mask*s.weight.x,0.0,1.0));
}
`;
}

export function createRegionalShapeBakeWgsl() {
    return `
struct ShapeBakeParams { address: vec4<f32>, info: vec4<f32>, }
@group(0) @binding(6) var<uniform> shapeBake: ShapeBakeParams;
@group(0) @binding(7) var shapeBakeField: texture_storage_2d<rg32float,write>;
@group(0) @binding(8) var<storage,read_write> shapeBakeHeights: array<f32>;
@compute @workgroup_size(8,8)
fn regionalShapeBakeMain(@builtin(global_invocation_id) id: vec3<u32>) {
    let cells=u32(shapeBake.info.x);let size=cells+3u;
    if(any(id.xy>=vec2<u32>(size))) { return; }
    let uv=(shapeBake.address.zw+(vec2<f32>(id.xy)-1.0)/f32(cells))/shapeBake.address.y;
    let dir=getSpherePoint(i32(shapeBake.address.x),uv.x,uv.y);
    let h=calculateTerrainHeightBaseD(uniforms.seed,dir).x*maxTerrainHeightM();
    textureStore(shapeBakeField,vec2<i32>(id.xy),vec4<f32>(h,0.0,0.0,0.0));
    shapeBakeHeights[id.y*size+id.x]=h;
}
`;
}
