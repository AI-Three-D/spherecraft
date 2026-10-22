// Reversible check of non-regional traversal distance, using resident heights.
import {buildTraversalShaderSource} from '../../../core/world/quadtree/quadtreeTraversal.wgsl.js';

export async function installHeightLod() {
    const g=window.gameEngine,tm=g.renderer.quadtreeTileManager,q=tm.quadtreeGPU,d=q.device;
    if(g.terrainGenerator.regionalTerrainActive)throw new Error('Non-regional diagnostic only');
    const previous={pipeline:q._regionalPipeline,group:q._regionalBindGroup,set:q.setRegionalTerrain};
    const helper=`
@group(1) @binding(0) var lodHeights:texture_2d_array<f32>;
fn residentLodCentre(tile:vec4<u32>,centre:vec3<f32>)->vec3<f32> {
    let uv=(vec2<f32>(tile.zw)+.5)/f32(1u<<tile.y);
    var depth=tile.y;
    var xy=tile.zw;
    loop {
        let lo=makeKeyLo(xy.x,xy.y);let hi=makeKeyHi(tile.x,depth);
        var idx=hashKey(lo,hi,params.loadedTableMask);
        for(var k=0u;k<min(params.loadedTableCapacity,256u);k++){
            let e=loadedTable[idx];
            if(e.keyHi==EMPTY_KEY){break;}
            if(e.keyHi==hi && e.keyLo==lo) {
                let size=vec2<i32>(textureDimensions(lodHeights));
                let local=uv*f32(1u<<depth)-vec2<f32>(xy);
                let at=clamp(vec2<i32>(local*vec2<f32>(size)),vec2<i32>(0),size-1);
                let height=textureLoad(lodHeights,at,i32(e.layer),0).x*${Number(g.planetConfig.maxTerrainHeight).toFixed(1)};
                return centre+normalize(centre-params.planetOrigin)*max(0.0,height);
            }
            idx=(idx+1u)&params.loadedTableMask;
        }
        if(depth==0u){break;}depth--;xy>>=vec2<u32>(1u);
    }
    return centre;
}
`;
    const code=helper+buildTraversalShaderSource({workgroupSize:q.workgroupSize,
        disableCulling:!q.enableFrustumCulling&&!q.enableHorizonCulling})
        .replace('shouldSubdivideWithCenter(depth, worldCenter)','shouldSubdivideWithCenter(depth, residentLodCentre(tile,worldCenter))');
    const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,texture:{viewDimension:'2d-array',sampleType:'unfilterable-float'}}]});
    const pipeline=await d.createComputePipelineAsync({layout:d.createPipelineLayout({bindGroupLayouts:[q._bindGroupLayout,layout]}),
        compute:{module:d.createShaderModule({code}),entryPoint:'main'}});
    const group=d.createBindGroup({layout,entries:[{binding:0,resource:tm.tileStreamer.arrayPool.textures.get('height').createView({dimension:'2d-array'})}]});
    q._regionalPipeline=pipeline;q._regionalBindGroup=group;q.setRegionalTerrain=()=>{};
    window.__restoreHeightLod=()=>{q._regionalPipeline=previous.pipeline;q._regionalBindGroup=previous.group;q.setRegionalTerrain=previous.set;delete window.__restoreHeightLod;};
    return {mode:'resident-height-distance',maxTerrainHeight:g.planetConfig.maxTerrainHeight};
}
