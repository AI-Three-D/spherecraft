// Bounded traversal experiment: retain detail only in requested shore pages.
// Literal keys keep the experiment separate from a production residency API.
import {buildTraversalShaderSource} from '../../../core/world/quadtree/quadtreeTraversal.wgsl.js';
import {faceUVToDir} from '../../../core/world/hydrology/waterGraph.js';

export async function installShoreLod(metadata,{depth=10,rangeM=1100}={}) {
    const g=window.gameEngine,q=g.renderer.quadtreeTileManager.quadtreeGPU,d=q.device,cam=g.camera.position,o=g.planetConfig.origin;
    if(g.terrainGenerator.regionalTerrainActive)throw new Error('Review override requires the non-regional traversal');
    if(depth>11)throw new Error('Review key packing is limited to this planet; not a production key format');
    const keys=new Set(),requested=new Set();
    for(const page of metadata.pages) {
        const targetDepth=metadata.depths?.[page]??depth;
        const [,face,sourceDepth,xx,yy]=page.match(/^f(\d+):d(\d+):(\d+),(\d+)$/).map(Number),D=2**sourceDepth;
        const dir=faceUVToDir(face,(xx+.5)/D,(yy+.5)/D),p=dir.map(v=>v*(g.waterGpuData.R+metadata.level));
        if(Math.hypot(p[0]-cam.x+o.x,p[1]-cam.y+o.y,p[2]-cam.z+o.z)>rangeM+2*g.waterGpuData.R/D)continue;
        const shift=sourceDepth-targetDepth;if(shift<0)throw new Error('Requested shore depth exceeds source depth');
        requested.add(`${face}/${targetDepth}/${xx>>shift}/${yy>>shift}`);
        for(let z=0;z<targetDepth;z++){const s=sourceDepth-z;keys.add((face*2**28+z*2**24+(xx>>s)*4096+(yy>>s))>>>0);}
    }
    const sorted=[...keys].sort((a,b)=>a-b);if(!sorted.length)throw new Error('No shore detail requests');
    const helper=`
const shoreKeys=array<u32,${sorted.length}>(${sorted.map(k=>k+'u').join(',')});
fn retainShore(tile:vec4<u32>)->bool {
    if(tile.y>=${depth}u){return false;}
    let key=tile.x*268435456u+tile.y*16777216u+tile.z*4096u+tile.w;
    var lo=0u;var hi=${sorted.length}u;
    loop {if(lo>=hi){break;}let m=(lo+hi)/2u;if(shoreKeys[m]<key){lo=m+1u;}else{hi=m;}}
    if(lo>=${sorted.length}u){return false;}return shoreKeys[lo]==key;
}
`;
    let code=buildTraversalShaderSource({workgroupSize:q.workgroupSize,disableCulling:!q.enableFrustumCulling&&!q.enableHorizonCulling});
    const marker='let wantSubdivide = shouldSubdivideWithCenter(depth, worldCenter);';
    if(!code.includes(marker))throw new Error('Traversal hook changed');
    code=helper+code.replace(marker,'let wantSubdivide = retainShore(tile) || shouldSubdivideWithCenter(depth, worldCenter);');
    const original=q._pipeline,started=Date.now();
    const pipeline=await d.createComputePipelineAsync({label:'Review local shore detail',
        layout:d.createPipelineLayout({bindGroupLayouts:[q._bindGroupLayout]}),compute:{module:d.createShaderModule({code}),entryPoint:'main'}});
    q._pipeline=pipeline;window.__restoreShoreLod=()=>{q._pipeline=original;delete window.__restoreShoreLod;};
    return {depth,rangeM,shoreTiles:requested.size,ancestorKeys:keys.size,compileMs:Date.now()-started,requested:[...requested]};
}
