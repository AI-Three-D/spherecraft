// Optional browser-only timestamp instrumentation, installed before renderer initialization.
export function installGpuTiming() {
   window.gpuSamples=[];window.gpuPassSamples=[];window.profileGpu=false;window.gpuPending=0;
   const request=GPUAdapter.prototype.requestDevice;
   GPUAdapter.prototype.requestDevice=async function(descriptor={}) {
     const features=[...(descriptor.requiredFeatures??[])];
     if(this.features.has('timestamp-query')&&!features.includes('timestamp-query'))features.push('timestamp-query');
     const device=await request.call(this,{...descriptor,requiredFeatures:features});
     window.hasGpuTimestamps=device.features.has('timestamp-query');
     if(!window.hasGpuTimestamps)return device;
     const slots=Array.from({length:8},()=>({busy:false,query:device.createQuerySet({type:'timestamp',count:32}),resolve:device.createBuffer({size:256,usage:512|4}),read:device.createBuffer({size:256,usage:1|8})}));
     const cbSlots=new WeakMap();
     const create=device.createCommandEncoder.bind(device);
     device.createCommandEncoder=function(...args){
       const encoder=create(...args);const slot=window.profileGpu?slots.find(s=>!s.busy):null;
       if(!slot)return encoder;
       slot.busy=true;slot.count=0;slot.labels=[];
       const begin=encoder.beginRenderPass.bind(encoder),finish=encoder.finish.bind(encoder);
       encoder.beginRenderPass=function(desc){const i=slot.count;slot.count+=2;slot.labels.push(desc.label??"render");return begin({...desc,timestampWrites:{querySet:slot.query,beginningOfPassWriteIndex:i,endOfPassWriteIndex:i+1}});};
       const beginCompute=encoder.beginComputePass.bind(encoder);
       encoder.beginComputePass=function(desc={}){const i=slot.count;slot.count+=2;slot.labels.push(desc.label??"compute");return beginCompute({...desc,timestampWrites:{querySet:slot.query,beginningOfPassWriteIndex:i,endOfPassWriteIndex:i+1}});};
       encoder.finish=function(...a){
         if(slot.count){encoder.resolveQuerySet(slot.query,0,slot.count,slot.resolve,0);encoder.copyBufferToBuffer(slot.resolve,0,slot.read,0,slot.count*8);}
         const cb=finish(...a);cbSlots.set(cb,slot);return cb;
       };
       return encoder;
     };
     const submit=device.queue.submit.bind(device.queue);
     device.queue.submit=function(buffers){const list=Array.from(buffers);submit(list);for(const cb of list){const slot=cbSlots.get(cb);if(!slot)continue;if(!slot.count){slot.busy=false;continue;}window.gpuPending++;slot.read.mapAsync(1).then(()=>{const t=new BigUint64Array(slot.read.getMappedRange());const ms=Number(t[slot.count-1]-t[0])/1e6;window.gpuSamples.push(ms);window.gpuPassSamples.push(slot.labels.map((label,i)=>({label,ms:Number(t[i*2+1]-t[i*2])/1e6})));slot.read.unmap();slot.busy=false;window.gpuPending--;});}};
     return device;
   };
}
