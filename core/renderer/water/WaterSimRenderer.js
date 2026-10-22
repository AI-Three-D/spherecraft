// Close river surface reads the bounded Whitewater simulation directly.
// It shares current water/atmosphere bindings and premultiplied lighting.
import { Geometry } from '../resources/geometry.js';
import { createNearWaterMaterial } from './NearWaterRenderer.js';
import { fillNearWaterUniforms, NEAR_WATER_UNIFORM_FLOATS } from './nearWaterUniforms.js';
import { aerialFadeRange } from '../terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js';
import { buildWaterSimFragmentShader, buildWaterSimVertexShader } from './waterSimSurface.wgsl.js';
import { gridIndices } from './waterGrid.js';
export { gridIndices } from './waterGrid.js';

export class WaterSimRenderer {
    constructor({backend,uniformManager,planetConfig,engineConfig}) {
        Object.assign(this,{backend,uniformManager,planetConfig});
        this.apFade=aerialFadeRange(engineConfig?.rendering?.terrainShader);
        this._uniforms=new Float32Array(NEAR_WATER_UNIFORM_FLOATS);
        this._simUniforms=new Float32Array(12);
        this.site=null;this.water=null;this._dims='';this._geometry=null;this._material=null;
    }
    setSite(site,water) {
        this.site=site??null;this.water=water??null;
        if(!site)return;
        if(this._material){
            site.surfaceReady=!!this._material._gpuPipeline;
            this._material._pipelinePromise?.then(pipeline=>{if(this.site===site&&pipeline)site.surfaceReady=true;});
            return;
        }
        this._material=createNearWaterMaterial('WaterSimSurface',buildWaterSimVertexShader(),buildWaterSimFragmentShader(),this._uniforms,[{
            label:'WaterSim-Strip',entries:[
                {binding:0,visibility:'vertex',name:'bed',buffer:{type:'read-only-storage'}},
                {binding:1,visibility:'vertex',name:'state',buffer:{type:'read-only-storage'}},
                {binding:2,visibility:'vertex',name:'turbulence',buffer:{type:'read-only-storage'}},
                {binding:3,visibility:'vertex',name:'rows',buffer:{type:'read-only-storage'}},
                {binding:4,visibility:'vertex|fragment',name:'simRenderUniforms',buffer:{type:'uniform'}},
            ],
        }]);
        this._material.uniforms.simRenderUniforms={value:this._simUniforms};
        site.surfaceReady=false;
        this._material.asyncCompile=true;
        this.backend.compileShader(this._material);
        const ready=this._material._pipelinePromise??Promise.resolve(this._material._gpuPipeline);
        ready.then(pipeline=>{if(this.site===site&&pipeline)site.surfaceReady=true;});
    }
    render(camera,viewMatrix,projectionMatrix) {
        const site=this.site,water=this.water;
        if(!site?.sim||site.state!=='running'||site.fade<=0||!water?._ready||!water.enabled||!water.near?.enabled||water.debugMode!==0)return;
        const dims=`${site.W}x${site.L}`;
        if(this._dims!==dims){
            this._geometry?.dispose?.();this._geometry=new Geometry();this._geometry.setIndex(gridIndices(site.W,site.L));this._dims=dims;
        }
        fillNearWaterUniforms(this._uniforms,{viewMatrix,projectionMatrix,camera,water,planetConfig:this.planetConfig,
            uniformManager:this.uniformManager,apFade:this.apFade});
        const p=site.sim.params,c=site.config;
        this._simUniforms.set([p.dx,site.W,site.L,site.sim.rowBase,p.hmin,site.sim.time,site.fade,c.endFadeM,c.waveAmpM,c.sideFadeM,0,0]);
        const res=water.resources,m=this._material;
        m.storageBuffers={waterIndex:res.index,waterLakes:res.lakes,waterRivers:res.rivers,
            bed:site.sim.bedBuffer,state:site.sim.stateBuffer,turbulence:site.sim.kBuffers[0],rows:site.rowsBuffer};
        if(m.uniforms.waterParams.value?.buffer!==water.paramsData)m.uniforms.waterParams.value=new Float32Array(water.paramsData);
        m.uniforms.waterLakeMasks.value=res.masks;
        m.uniforms.transmittanceLUT.value=this.uniformManager?.uniforms?.transmittanceLUT?.value??null;
        m.uniforms.nearWaterSceneDepth.value=this.backend.getDepthTextureView();
        this.backend.endRenderPassForCompute();
        this.backend.resumeRenderPass({depthReadOnly:true});
        this.backend.draw(this._geometry,m);
        this.backend.endRenderPassForCompute();
        this.backend.resumeRenderPass();
    }
    dispose(){this._geometry?.dispose?.();this._material?.dispose?.();this._geometry=null;this._material=null;}
}
