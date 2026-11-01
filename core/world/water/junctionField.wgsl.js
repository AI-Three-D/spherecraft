import { JUNCTION_FIELD_CAPACITY } from './junctionFieldStore.js';

// Shared spatial coordinates for terrain generation and water rendering.
export const JUNCTION_FIELD_LAYOUT_WGSL = `
struct JunctionFieldU {
 c:vec3<f32>,R:f32,e1:vec3<f32>,x0:f32,e2:vec3<f32>,y0:f32,
 grid:vec4<f32>,
};
`;

const terrainSamplingWgsl = `
fn junctionCubic(t:f32)->vec4<f32> {
 let v=1.0-t;let t2=t*t;let t3=t2*t;
 return vec4<f32>(v*v*v,3.0*t3-6.0*t2+4.0,-3.0*t3+3.0*t2+3.0*t+1.0,t3)/6.0;
}
fn junctionCubicDerivative(t:f32)->vec4<f32> {
 return vec4<f32>(-.5*(1.0-t)*(1.0-t),1.5*t*t-2.0*t,-1.5*t*t+t+.5,.5*t*t);
}
fn junctionTerrainSample(old:vec4<f32>,natural:vec4<f32>,dir:vec3<f32>,F:JunctionFieldU,base:u32)->vec4<f32> {
 if(F.grid.w<.5){return old;}
 let k=dot(dir,F.c);if(k<=0.0){return old;}
 let a=dot(dir,F.e1);let b=dot(dir,F.e2);
 let uv=(F.R*vec2<f32>(a,b)/k-vec2<f32>(F.x0,F.y0))/F.grid.z;
 if(any(uv<vec2<f32>(1.0))||any(uv>=F.grid.xy-vec2<f32>(2.0))){return old;}
 let gx=F.R*(F.e1*k-F.c*a)/(k*k*F.grid.z);
 let gy=F.R*(F.e2*k-F.c*b)/(k*k*F.grid.z);
 let ij=vec2<i32>(floor(uv));let f=fract(uv);
 let wx=junctionCubic(f.x);let wy=junctionCubic(f.y);
 let dx=junctionCubicDerivative(f.x);let dy=junctionCubicDerivative(f.y);
 var value=vec2<f32>(0.0);var gradientX=vec2<f32>(0.0);var gradientY=vec2<f32>(0.0);
 for(var y=0;y<4;y++){for(var x=0;x<4;x++){
  let p=ij+vec2<i32>(x-1,y-1);
  let h=junctionTerrain[base+u32(p.y)*u32(F.grid.x)+u32(p.x)].yz;
  value+=h*wx[x]*wy[y];gradientX+=h*dx[x]*wy[y];gradientY+=h*wx[x]*dy[y];
 }}
 var bed=vec4<f32>(value.x,gradientX.x*gx+gradientY.x*gy);
 if(bed.x>natural.x){bed=natural;}
 let ux=vec4<f32>(uv.x,gx);let uy=vec4<f32>(uv.y,gy);
 let left=dSmoothstep(1.0,5.0,ux);let right=dSmoothstep(1.0,5.0,dConst(F.grid.x-1.0)-ux);
 let bottom=dSmoothstep(1.0,5.0,uy);let top=dSmoothstep(1.0,5.0,dConst(F.grid.y-1.0)-uy);
 let impact=vec4<f32>(value.y,gradientX.y*gx+gradientY.y*gy);
 let weight=dMul(dMul(dMul(left,right),dMul(bottom,top)),impact);
 return old+dMul(bed-old,weight);
}
`;

export function junctionFieldTerrainWgsl(group=3) {
    return JUNCTION_FIELD_LAYOUT_WGSL+`
@group(${group}) @binding(0) var<uniform> junctionTerrainU:JunctionFieldU;
@group(${group}) @binding(1) var<storage,read> junctionTerrain:array<vec4<f32>>;
`+terrainSamplingWgsl+`
fn junctionTerrainAt(old:vec4<f32>,natural:vec4<f32>,dir:vec3<f32>)->vec4<f32> {
 return junctionTerrainSample(old,natural,dir,junctionTerrainU,0u);
}
`;
}

export function junctionFieldLookupWgsl(group=3) {
    return JUNCTION_FIELD_LAYOUT_WGSL+`
struct JunctionFieldRecord { frame:JunctionFieldU,range:vec4<u32>, }
struct JunctionFieldSet { info:vec4<u32>,records:array<JunctionFieldRecord,${JUNCTION_FIELD_CAPACITY}>, }
@group(${group}) @binding(0) var<uniform> junctionSet:JunctionFieldSet;
@group(${group}) @binding(1) var<storage,read> junctionTerrain:array<vec4<f32>>;
struct JunctionLocation { found:bool,slot:u32,uv:vec2<f32>, }
fn junctionLocate(dir:vec3<f32>)->JunctionLocation {
 var result:JunctionLocation;
 for(var slot=0u;slot<min(junctionSet.info.x,${JUNCTION_FIELD_CAPACITY}u);slot++) {
  let F=junctionSet.records[slot].frame;let k=dot(dir,F.c);
  if(k<.5||F.grid.w<.5){continue;}
  let xy=F.R*vec2<f32>(dot(dir,F.e1),dot(dir,F.e2))/k;
  let uv=(xy-vec2<f32>(F.x0,F.y0))/F.grid.z;
  if(all(uv>=vec2<f32>(1.0))&&all(uv<F.grid.xy-vec2<f32>(2.0))) {
   result.found=true;result.slot=slot;result.uv=uv;return result;
  }
 }
 return result;
}
fn junctionLocateMasked(dir:vec3<f32>,mask:u32)->JunctionLocation {
 var remaining=mask;var result:JunctionLocation;
 loop {
  if(remaining==0u){break;}
  let slot=firstTrailingBit(remaining);remaining&=remaining-1u;
  if(slot>=junctionSet.info.x){continue;}
  let F=junctionSet.records[slot].frame;let k=dot(dir,F.c);
  if(k<.5||F.grid.w<.5){continue;}
  let uv=(F.R*vec2<f32>(dot(dir,F.e1),dot(dir,F.e2))/k-vec2<f32>(F.x0,F.y0))/F.grid.z;
  if(all(uv>=vec2<f32>(1.0))&&all(uv<F.grid.xy-vec2<f32>(2.0))) {
   result.found=true;result.slot=slot;result.uv=uv;return result;
  }
 }
 return result;
}
fn junctionValue(location:JunctionLocation)->vec4<f32> {
 if(!location.found){return vec4<f32>(0.0);}
 let record=junctionSet.records[location.slot];let p=vec2<u32>(floor(location.uv));let t=fract(location.uv);
 let width=u32(record.frame.grid.x);let i=record.range.x+p.y*width+p.x;
 return mix(mix(junctionTerrain[i],junctionTerrain[i+1u],t.x),mix(junctionTerrain[i+width],junctionTerrain[i+width+1u],t.x),t.y);
}
`;
}

export function junctionFieldSetTerrainWgsl(group=3) {
    return junctionFieldLookupWgsl(group)+terrainSamplingWgsl+`
fn junctionTerrainAt(old:vec4<f32>,natural:vec4<f32>,dir:vec3<f32>)->vec4<f32> {
 let location=junctionLocate(dir);if(!location.found){return old;}
 let record=junctionSet.records[location.slot];
 return junctionTerrainSample(old,natural,dir,record.frame,record.range.x);
}
fn junctionTerrainCore(dir:vec3<f32>)->bool {
 let location=junctionLocate(dir);if(!location.found){return false;}
 let F=junctionSet.records[location.slot].frame;
 if(any(location.uv<vec2<f32>(5.0))||any(location.uv>F.grid.xy-vec2<f32>(6.0))){return false;}
 let p=vec2<u32>(floor(location.uv));let base=junctionSet.records[location.slot].range.x;
 for(var y=0u;y<4u;y++){for(var x=0u;x<4u;x++){
  if(junctionTerrain[base+(p.y+y-1u)*u32(F.grid.x)+p.x+x-1u].z<.999999){return false;}
 }}
 return true;
}
`;
}
