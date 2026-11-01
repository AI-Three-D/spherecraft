// Rejected regular-grid water experiment. Production uses the field only for
// terrain and retains conservative lake/ribbon meshes for water coverage.
import { Geometry } from '../../../core/renderer/resources/geometry.js';
import { createNearWaterMaterial } from '../../../core/renderer/water/NearWaterRenderer.js';
import { commonWgsl, shadeWgsl, NEAR_WATER_UNIFORM_FLOATS } from '../../../core/renderer/water/nearWaterSurface.wgsl.js';
import { fillNearWaterUniforms } from '../../../core/renderer/water/nearWaterUniforms.js';
import { gridIndices } from '../../../core/renderer/water/waterGrid.js';
import { JUNCTION_FIELD_LAYOUT_WGSL } from '../../../core/world/water/junctionField.wgsl.js';

export function junctionFieldParams(frame,radiusM,enabled=true) {
    return Float32Array.from([...frame.c,radiusM,...frame.e1,frame.x0,...frame.e2,frame.y0,
        frame.width,frame.height,frame.spacingM,enabled?1:0]);
}

export function junctionFieldRegionWgsl(group=3) {
    return JUNCTION_FIELD_LAYOUT_WGSL+`
@group(${group}) @binding(0) var<uniform> junctionFieldU:JunctionFieldU;
fn junctionFieldContains(wp:vec3<f32>,origin:vec3<f32>)->bool {
 if(junctionFieldU.grid.w<.5){return false;}
 let dir=normalize(wp-origin);let k=dot(dir,junctionFieldU.c);
 if(k<=0.0){return false;}
 let xy=vec2<f32>(dot(dir,junctionFieldU.e1),dot(dir,junctionFieldU.e2))*junctionFieldU.R/k;
 let uv=(xy-vec2<f32>(junctionFieldU.x0,junctionFieldU.y0))/junctionFieldU.grid.z;
 // Keep one outer ring outside the replacement region; both meshes use
 // the same half-open domain, so no duplicate surface is composited.
 return all(uv>=vec2<f32>(1.0))&&all(uv<junctionFieldU.grid.xy-vec2<f32>(2.0));
}
`;
}

export function createJunctionFieldVertexShader() {
    return commonWgsl()+JUNCTION_FIELD_LAYOUT_WGSL+`
@group(2) @binding(0) var<storage,read> junctionField:array<vec4<f32>>;
@group(2) @binding(1) var<uniform> F:JunctionFieldU;
struct FieldVOut {
 @builtin(position) pos:vec4<f32>,
 @location(0) wp:vec3<f32>,
 @location(1) wet:f32,
};
@vertex
fn main(@builtin(vertex_index) vi:u32)->FieldVOut {
 let w=u32(F.grid.x);let p=vec2<u32>(vi%w,vi/w);
 let xy=vec2<f32>(F.x0,F.y0)+vec2<f32>(p)*F.grid.z;
 let dir=normalize(F.c+(F.e1*xy.x+F.e2*xy.y)/F.R);
 let value=junctionField[vi];let wp=U.origin+dir*(F.R+value.x);
 var o:FieldVOut;o.pos=nearWaterRasterPosition(wp);o.wp=wp;o.wet=value.z;return o;
}
`;
}

export function createJunctionFieldFragmentShader() {
    return commonWgsl()+shadeWgsl()+junctionFieldRegionWgsl(2).replace('@binding(0)','@binding(1)')+`
struct FieldVOut {
 @builtin(position) pos:vec4<f32>,
 @location(0) wp:vec3<f32>,
 @location(1) wet:f32,
};
@fragment
fn main(in:FieldVOut)->@location(0) vec4<f32> {
 // Cover the smoothing support of the bed. Opaque terrain, rather than
 // the sampled wet-domain contour, defines the visible shoreline.
 if(in.wet<=-8.0||!junctionFieldContains(in.wp,U.origin)){discard;}
 let n=normalize(cross(dpdx(in.wp),dpdy(in.wp)));
 let up=normalize(in.wp-U.origin);let plane=n*select(-1.0,1.0,dot(n,up)>=0.0);
 let color=nearWaterShade(in.wp,in.pos.xy,plane);
 if(color.a<=0.0){discard;}return color;
}
`;
}

// Prototype renderer for one solved patch. It reads a spatial field directly:
// no nearest-segment scan, river endpoint cap or lake/ribbon alpha handover.
export class JunctionFieldRenderer {
    constructor({backend,uniformManager,planetConfig,water,field,fieldBuffer,apFade}) {
        this.backend=backend;this.uniformManager=uniformManager;this.planetConfig=planetConfig;
        this.water=water;this.apFade=apFade;this.uniforms=new Float32Array(NEAR_WATER_UNIFORM_FLOATS);
        this.geometry=new Geometry();this.geometry.setIndex(gridIndices(field.width,field.height));
        this.params=junctionFieldParams(field.frame,water.R);
        this.material=createNearWaterMaterial('JunctionField',createJunctionFieldVertexShader(),createJunctionFieldFragmentShader(),this.uniforms,[{
            label:'JunctionField-Data',entries:[
                {binding:0,visibility:'vertex',name:'junctionField',buffer:{type:'read-only-storage'}},
                {binding:1,visibility:'vertex|fragment',name:'junctionFieldU',buffer:{type:'uniform'}},
            ],
        }]);
        this.material.depthCompare='less-equal';this.material.storageBuffers.junctionField=fieldBuffer;
        this.material.uniforms.junctionFieldU={value:this.params};
    }
    render(camera,viewMatrix,projectionMatrix) {
        const water=this.water;if(!water.enabled||water.debugMode===10)return;
        fillNearWaterUniforms(this.uniforms,{viewMatrix,projectionMatrix,planetConfig:this.planetConfig,
            uniformManager:this.uniformManager,camera,water,apFade:this.apFade});
        const m=this.material,r=water.resources,g=this.uniformManager.uniforms;
        m.storageBuffers.waterIndex=r.index;m.storageBuffers.waterLakes=r.lakes;m.storageBuffers.waterRivers=r.rivers;
        m.uniforms.waterParams.value=new Float32Array(water.paramsData);
        m.uniforms.waterLakeMasks.value=r.masks;
        m.uniforms.transmittanceLUT.value=g.transmittanceLUT?.value??null;
        m.uniforms.nearWaterSceneDepth.value=this.backend.getDepthTextureView();
        this.backend.endRenderPassForCompute();this.backend.resumeRenderPass({depthReadOnly:true});
        this.backend.draw(this.geometry,m);
        this.backend.endRenderPassForCompute();this.backend.resumeRenderPass();
    }
    dispose(){this.geometry.dispose?.();this.material.dispose?.();}
}
