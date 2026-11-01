const sampleWgsl=`
@group(3) @binding(1) var<storage,read> junctionRenderField:array<vec4<f32>>;
struct JunctionRenderSample { on:bool,v:vec4<f32>, }
fn junctionRenderSample(wp:vec3<f32>)->JunctionRenderSample {
 var result:JunctionRenderSample;
 if(!junctionFieldContains(wp,U.origin)){return result;}
 let F=junctionFieldU;let dir=normalize(wp-U.origin);let k=dot(dir,F.c);
 let xy=vec2<f32>(dot(dir,F.e1),dot(dir,F.e2))*F.R/k;
 let uv=(xy-vec2<f32>(F.x0,F.y0))/F.grid.z;
 let p=vec2<u32>(floor(uv));let t=fract(uv);let w=u32(F.grid.x);let i=p.y*w+p.x;
 result.v=mix(mix(junctionRenderField[i],junctionRenderField[i+1u],t.x),mix(junctionRenderField[i+w],junctionRenderField[i+w+1u],t.x),t.y);
 result.on=true;return result;
}
`;

export function installJunctionSurfacePrototype() {
    const state=window.__junctionField,near=gameEngine.renderer.nearWaterRenderer,b=near.backend;
    state.renderer.render=()=>{};
    const originalDraw=b.draw,originals=[];
    for(const m of [near._lakeMaterial,near._riverMaterial]) {
        originals.push({m,fs:m.fragmentShader,spec:m.bindGroupLayoutSpec.map(g=>({...g,entries:[...g.entries]}))});
        m.fragmentShader=m.fragmentShader.replace('if(junctionFieldContains(in.wp,U.origin)){discard;}','');
        m.fragmentShader+=sampleWgsl;
        m.bindGroupLayoutSpec[3].entries.push({binding:1,visibility:'fragment',name:'junctionRenderField',buffer:{type:'read-only-storage'}});
        m.uniforms.junctionFieldU.value[15]=1;m._needsCompile=true;
    }
    const lake=near._lakeMaterial,river=near._riverMaterial;
    lake.fragmentShader=lake.fragmentShader.replace('if(nearWaterBehind(in.wp,in.pos.xy)<=0.0) {discard;}',`
if(nearWaterBehind(in.wp,in.pos.xy)<=0.0) {discard;}
let junction=junctionRenderSample(in.wp);
if(junction.on&&junction.v.w>0.0&&abs(junction.v.x-waterLakes[in.lake].level)<.05) {
 let color=nearWaterShade(in.wp,in.pos.xy,normalize(in.wp-U.origin));
 if(color.a<=0.0){discard;}return color;
}`);
    river.fragmentShader=river.fragmentShader.replace('if(nearOpaqueAboveRiver(in.wp,in.pos.xy,in.maxLevel)) {discard;}',`
if(nearOpaqueAboveRiver(in.wp,in.pos.xy,in.maxLevel)) {discard;}
let junction=junctionRenderSample(in.wp);
if(junction.on&&junction.v.w>0.0){discard;}`);
    b.draw=function(geometry,material,...args) {
        if(material===lake||material===river)material.storageBuffers.junctionRenderField=state.renderer.material.storageBuffers.junctionField;
        return originalDraw.call(this,geometry,material,...args);
    };
    state.surfacePrototype={restore(){b.draw=originalDraw;for(const {m,fs,spec}of originals){m.fragmentShader=fs;m.bindGroupLayoutSpec=spec;m._needsCompile=true;}}};
    return {kind:'existing meshes, shared connected-basin ownership'};
}

export function junctionSurfacePrototypeStats() {
    return {field:window.__junctionStats,gpuErrors:window.__lr.gpuErrors,pose:window.__lr.pose()};
}
