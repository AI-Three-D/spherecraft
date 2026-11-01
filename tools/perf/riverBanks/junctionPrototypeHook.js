// Isolated experiment instrumentation, installed before game bootstrap.
// Production integration must publish these resources through the world API.
export function installJunctionPrototypeHook(terrainWgsl) {
    const modules=new WeakMap(),layouts=new WeakMap(),pipelines=new WeakMap(),passes=new WeakMap(),devices=new WeakMap();
    const D=GPUDevice.prototype,C=GPUComputePassEncoder.prototype;
    const shader=D.createShaderModule,layout=D.createPipelineLayout,compute=D.createComputePipeline,asyncCompute=D.createComputePipelineAsync;
    function resources(device) {
        let r=devices.get(device);if(r)return r;
        const uniform=device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        const field=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
        const bgl=device.createBindGroupLayout({entries:[
            {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
            {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
        ]});
        r={device,uniform,field,bgl,groups:new WeakMap()};devices.set(device,r);return r;
    }
    D.createShaderModule=function(desc) {
        let code=desc.code,changed=false;
        if(code.includes('return (h + fill) / maxH;')) {
            code=code.replace('return (h + fill) / maxH;','return junctionTerrainAt(h+fill,natural*maxH,unitDir)/maxH;')
                .replace('if (count == 0u) { return hd; }','if (count == 0u) { let mh=maxTerrainHeightM();return junctionTerrainAt(hd*mh,natural*mh,unitDir)/mh; }');
            code+=terrainWgsl;changed=true;
        }
        const m=shader.call(this,{...desc,code});if(changed)modules.set(m,this);return m;
    };
    D.createPipelineLayout=function(desc){const l=layout.call(this,desc);layouts.set(l,desc.bindGroupLayouts);return l;};
    function prepare(device,desc) {
        if(!modules.has(desc.compute.module))return desc;
        const r=resources(device),prior=layouts.get(desc.layout);
        if(!prior)return desc;
        const groups=[...prior];while(groups.length<3)groups.push(device.createBindGroupLayout({entries:[]}));
        if(groups.length!==3)throw new Error('Prototype requires unused compute group 3');
        groups.push(r.bgl);return {...desc,layout:layout.call(device,{bindGroupLayouts:groups})};
    }
    D.createComputePipeline=function(desc){const p=compute.call(this,prepare(this,desc));if(modules.has(desc.compute.module))pipelines.set(p,resources(this));return p;};
    D.createComputePipelineAsync=async function(desc){const p=await asyncCompute.call(this,prepare(this,desc));if(modules.has(desc.compute.module))pipelines.set(p,resources(this));return p;};
    const set=C.setPipeline,dispatch=C.dispatchWorkgroups;
    C.setPipeline=function(p){passes.set(this,p);return set.call(this,p);};
    C.dispatchWorkgroups=function(...args) {
        const p=passes.get(this),r=pipelines.get(p);
        if(r){let bg=r.groups.get(p);if(!bg){bg=r.device.createBindGroup({layout:p.getBindGroupLayout(3),entries:[
            {binding:0,resource:{buffer:r.uniform}},{binding:1,resource:{buffer:r.field}},
        ]});r.groups.set(p,bg);}this.setBindGroup(3,bg);}
        return dispatch.apply(this,args);
    };
    window.__junctionPrototype={
        setEnabled(device,enabled){const r=resources(device);device.queue.writeBuffer(r.uniform,60,new Float32Array([enabled?1:0]));},
        async upload(device,params,data) {
            const r=resources(device);await device.queue.onSubmittedWorkDone();
            r.field.destroy();r.field=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
            device.queue.writeBuffer(r.field,0,data);device.queue.writeBuffer(r.uniform,0,params);
            r.groups=new WeakMap();return r.field;
        },
    };
}
