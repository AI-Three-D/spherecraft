// Reuse compiled code, never terrain values or bind groups. Uniforms/resources
// belong to generation versions; unchanged macro inputs can be shared. The
// full source and entry points form the key, so changed compile-time contracts
// cannot receive an obsolete pipeline.
const devices=new WeakMap();
const MAX_PIPELINE_SETS=4;

export async function regionalComputePipelines(device,source,entryPoints,{reuse=true}={}) {
    let cache=devices.get(device);
    if(!cache) {cache=new Map();devices.set(device,cache);}
    const key=JSON.stringify(entryPoints)+source;
    if(reuse&&cache.has(key)) return {pipelines:await cache.get(key),cacheHit:true};
    const module=device.createShaderModule({label:'Regional generation source',code:source});
    const pending=Promise.all(entryPoints.map(entryPoint=>device.createComputePipelineAsync({
        label:`Regional ${entryPoint}`,layout:'auto',compute:{module,entryPoint},
    })));
    if(reuse) {
        cache.set(key,pending);
        while(cache.size>MAX_PIPELINE_SETS) cache.delete(cache.keys().next().value);
    }
    try {return {pipelines:await pending,cacheHit:false};}
    catch(error) {if(cache.get(key)===pending) cache.delete(key);throw error;}
}
